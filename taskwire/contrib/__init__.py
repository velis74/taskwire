"""Framework and driver adapters.

These are the only modules in the package that import a web framework, a Redis client, Celery or
muxws (TW-CORE-006). The core installs and passes its whole test suite with none of them present,
and that is a hard constraint rather than an aspiration - `packaging_test.py` asserts it in a fresh
interpreter on every run.

Import them explicitly:

```python
from taskwire.contrib.redis_store import RedisStore
from taskwire.contrib.fastapi import router
```

They are deliberately *not* re-exported from `taskwire` itself: doing so would make `import taskwire`
drag in whichever of them happened to be installed, which is exactly what TW-CORE-006 forbids.
"""
