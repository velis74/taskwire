"""Framework and driver adapters.

These are the only modules in the package that import a web framework, a Redis client, Celery or
muxws (TW-CORE-006). The core installs and runs with none of them present.

Import them explicitly:

```python
from taskwire.contrib.redis_store import RedisStore
from taskwire.contrib.fastapi import router
```

They are not re-exported from `taskwire`: `import taskwire` imports none of them (TW-CORE-006).
"""
