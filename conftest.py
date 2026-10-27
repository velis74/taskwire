"""The push delay (TW-THR-008) is off unless a test turns it on: the other tests assert what each
write publishes, which the delay would hold back."""

from collections.abc import Iterator

import pytest

from taskwire.settings import settings


@pytest.fixture(autouse=True)
def _no_push_delay() -> Iterator[None]:
    previous = settings.push_delay
    settings.push_delay = 0.0
    yield
    settings.push_delay = previous
