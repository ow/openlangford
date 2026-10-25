from pipeline.ingestion.other_documents import letter_files


def test_only_letter_files_are_picked(tmp_path):
    other = tmp_path / "Other Documents"
    other.mkdir()
    for name in ["Late Submission Bylaw No. 1965.pdf", "Addendum Correspondence Z21-0013.pdf", "Dial in Instructions.pdf",
                 "Special Council Meeting Notice.pdf", "Notice of Postponement for Public Hearing No. 1856.pdf",
                 "Correspondence.pdf", "Correspondence.pdf.url", "Jan 20 2025 - City of Langford 2025 Budget Presentation.pdf"]:
        (other / name).write_text("x")
    assert [p.split("/")[-1] for p in letter_files(str(tmp_path))] == [
        "Addendum Correspondence Z21-0013.pdf", "Correspondence.pdf", "Late Submission Bylaw No. 1965.pdf"]
    assert letter_files(str(tmp_path / "missing")) == []
