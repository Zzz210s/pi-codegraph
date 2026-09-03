// fixtures.js - shared Python source fixtures for codegraph tests.
// Not a test file (no *.test.js suffix): imported by symbols.test.js and
// indexer.test.js.

// Fixture covering: module-level def? (no - module class), class with decorator,
// class method, async module function with typed args, nested function.
export const FIXTURE = `import os
from typing import Optional

@dataclass
class Config:
    name: str
    def reload(self) -> None: ...

async def fetch(url: str, *, retry: int = 3) -> Optional[str]:
    def inner():
        pass
    return None
`;
