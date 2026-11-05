from pipeline.ingestion.matter_images import images_changed


def test_matters_are_picked_again_when_their_pictures_change():
    counts = {1: 5, 2: 5, 3: 4, 4: 3}
    rows = [
        {"id": 1, "images_seen": "5", "has_lead": True},    # unchanged since it was picked
        {"id": 2, "images_seen": "3", "has_lead": True},    # gained pictures in a merge
        {"id": 3, "images_seen": None, "has_lead": False},  # judged before counts were kept, still no photo
        {"id": 4, "images_seen": None, "has_lead": True},   # judged before counts were kept, has a photo: left alone
        {"id": 5, "images_seen": "2", "has_lead": False},   # its pictures went with a merge elsewhere
        {"id": 6, "images_seen": None, "has_lead": False},  # no pictures at all
    ]
    assert images_changed(rows, counts) == [2, 3, 5]
