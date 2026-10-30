"""Video source clients. Provider selection lives in ``pipeline.video.providers``."""

from pipeline.video.isilive import ISILiveClient
from pipeline.video.providers import YouTubeClient, get_video_client
from pipeline.video.vimeo import VimeoClient

__all__ = ["ISILiveClient", "VimeoClient", "YouTubeClient", "get_video_client"]
