import uvicorn

from vlearn.server import app  # noqa: F401 — exports app for uvicorn

if __name__ == "__main__":
    from vlearn import config
    uvicorn.run("main:app", host="0.0.0.0", port=config.PORT, reload=False)
