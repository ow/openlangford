"""Conservative, local-only date recovery from an original PDF's own header.

Called only after native date extraction fails. Native PRESENT geometry bounds
the first-page render; no roster, body, or prior-minutes date can enter OCR.
Unavailable Mac/Swift/Vision, conflicting candidates and malformed ordinals hold.
"""
from datetime import date, datetime
import hashlib
import json
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile

import fitz

_MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December'
_DATE = re.compile(
    r'(?:(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s*,?\s*)?'
    r'\b(' + _MONTHS + r')\s+(\d{1,2})(st|nd|rd|th|[17]H)?\s*,\s*(20\d{2})\b', re.I,
)


def _candidate_date(text):
    matches=list(_DATE.finditer(text))
    if len(matches)!=1:
        return None
    match=matches[0]
    weekday,month,day,ordinal,year=match.groups()
    try:
        parsed=datetime.strptime(f'{month} {day} {year}', '%B %d %Y').date()
    except ValueError:
        return None
    noisy=bool(ordinal) and ordinal.casefold() not in ('st','nd','rd','th')
    if noisy and not (weekday and len(day)==2):
        # A noisy ordinal ("117H") is accepted only when the weekday verifies.
        return None
    expected='th' if 10 <= parsed.day % 100 <= 20 else {1:'st',2:'nd',3:'rd'}.get(parsed.day % 10,'th')
    if ordinal and not noisy and ordinal.casefold()!=expected:
        return None
    if weekday and parsed.strftime('%A').casefold()!=weekday.casefold():
        return None
    return parsed,match[0],bool(weekday)


def recover_pdf_header_date(path, *, catalog_date, cache_dir):
    """Return (ISO date, bounded source evidence), or (None, None) on any hold."""
    if sys.platform!='darwin' or not shutil.which('swiftc'):
        return None,None
    try:
        path=Path(path)
        source_sha=hashlib.sha256(path.read_bytes()).hexdigest()
        swift=Path(__file__).with_name('native_header_vision.swift')
        helper_sha=hashlib.sha256(swift.read_bytes()).hexdigest()
        with fitz.open(path) as document:
            page=document[0]
            # Uppercase roster label only; body text may say lowercase "present".
            present=sorted((word for word in page.get_text('words') if re.fullmatch(r'PRESENT:?',word[4])),key=lambda w:(w[1],w[0]))
            # No native anchor cannot prove this is the own header; take the first.
            if not present or not 0<present[0][1]<page.rect.height*.65:
                return None,None
            clip=[page.rect.x0,page.rect.y0,page.rect.x1,present[0][1]]
            config={'source_sha256':source_sha,'helper_sha256':helper_sha,
                    'macos_version':platform.mac_ver()[0], 'machine':platform.machine(),
                    'engine':'macOS Vision VNRecognizeTextRequest','vision_revision':3,
                    'recognition_level':'accurate','languages':['en-US'],'language_correction':True,
                    'clip':clip,'page':1,'render_scale':6,'pymupdf_version':fitz.VersionBind}
            key=hashlib.sha256(json.dumps(config,sort_keys=True).encode()).hexdigest()
            folder=Path(cache_dir)/'native-header-ocr'/source_sha/key
            folder.mkdir(parents=True,exist_ok=True)
            image=folder/'header.png';receipt=folder/'ocr.json'
            if not image.exists():
                page.get_pixmap(matrix=fitz.Matrix(6,6),clip=fitz.Rect(clip)).save(image)
        render_sha=hashlib.sha256(image.read_bytes()).hexdigest()
        if receipt.exists():
            cached=json.loads(receipt.read_text())
            if cached['config']!=config or cached['render_sha256']!=render_sha:
                return None,None
            ocr=cached['ocr']
        else:
            # Vision's on-device model cache is bound to executable identity.
            # Hash the directory, not its basename: per-hash identities force
            # expensive cold Neural Engine compilation on every asset change.
            binary=Path(cache_dir)/'native-header-ocr'/f'helper-{helper_sha}-{platform.machine()}'/'langford-native-ocr'
            binary.parent.mkdir(parents=True,exist_ok=True)
            if not binary.exists():
                # Concurrent source jobs may compile independently, then atomically
                # publish the same hash-bound binary; never execute partial output.
                with tempfile.TemporaryDirectory(dir=binary.parent) as temp:
                    compiled=Path(temp)/'langford-native-ocr'
                    subprocess.run([shutil.which('swiftc'),str(swift),'-o',str(compiled)],check=True,capture_output=True,timeout=60)
                    compiled.replace(binary)
            output=subprocess.run([str(binary),str(image)],check=True,capture_output=True,text=True,timeout=40)
            ocr=json.loads(output.stdout)
            receipt.write_text(json.dumps({'config':config,'render_sha256':render_sha,'ocr':ocr},sort_keys=True))
        dates=[];quotes=[]
        for line in ocr['lines']:
            candidates=line['candidates']
            if not candidates:
                continue
            # A month+year makes this a date-bearing header line. Never choose
            # a convenient lower candidate when its top reading is malformed.
            if not any(re.search(r'\b(?:'+_MONTHS+r')\b',c['text'],re.I) and re.search(r'\b20\d{2}\b',c['text']) for c in candidates):
                continue
            if candidates[0]['confidence']!=1 or not _candidate_date(candidates[0]['text']):
                return None,None
            for candidate in candidates:
                if candidate['confidence']!=1:
                    continue
                parsed=_candidate_date(candidate['text'])
                if not parsed:
                    # Top must already be valid; malformed lower alternatives
                    # never supply a date. All other complete dates must agree.
                    continue
                dates.append(parsed[0]);quotes.append((candidate['text'],parsed[2],line['bounding_box']))
        if len(set(dates))!=1:
            return None,None
        recovered=dates[0]
        # Catalog comparison is last and never supplies an OCR digit.
        if abs((recovered-date.fromisoformat(str(catalog_date)[:10])).days)>1:
            return None,None
        if hashlib.sha256(path.read_bytes()).hexdigest()!=source_sha:
            return None,None
        return recovered.isoformat(),{
            'method':'macos_vision_original_pdf_header','source_quote':quotes[0][0],
            'weekday_verified':quotes[0][1],'source_sha256':source_sha,
            'render_sha256':render_sha,'render_file':str(image),'ocr_receipt':str(receipt),
            'ocr_receipt_sha256':hashlib.sha256(receipt.read_bytes()).hexdigest(),
            'engine':ocr['engine'],'vision_revision':ocr['vision_revision'],
            'helper_sha256':helper_sha,'engine_config':config,
            'date_candidates':[{'text':text,'confidence':1,'bounding_box':box} for text,_,box in quotes],
        }
    except (OSError,ValueError,KeyError,TypeError,IndexError,RuntimeError,subprocess.SubprocessError,fitz.FileDataError):
        return None,None
