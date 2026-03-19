import os
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
from fastapi.middleware.cors import CORSMiddleware
from .routers import router
from .shift_router import router as shift_router
from .connectors_router import router as connectors_router
from .code_converter_router import router as code_converter_router
from .llm_usage_router import router as llm_usage_router
from .deployment_router import router as deployment_router
from .d365_deploy_router import router as d365_deploy_router
from .agent_chat_router import router as agent_chat_router
from .power_automate_router import router as power_automate_router
from .auth_router import router as auth_router
from .admin_router import router as admin_router
from .database import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: create DB tables. Shutdown: nothing needed for SQLite."""
    init_db()
    yield


app = FastAPI(title="SF2Dynamics API", lifespan=lifespan)

# CORS must be added BEFORE including routes so OPTIONS preflight requests
# (sent by browsers before POST/DELETE) are intercepted correctly.
# allow_origin_regex matches ANY localhost port so dev servers never break.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://localhost(:\d+)?",
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "PUT", "PATCH", "OPTIONS"],
    allow_headers=["*"],
)

# Include API routers
app.include_router(router)
app.include_router(shift_router)
app.include_router(connectors_router)
app.include_router(code_converter_router)
app.include_router(llm_usage_router)
app.include_router(deployment_router)
app.include_router(d365_deploy_router)
app.include_router(agent_chat_router)
app.include_router(power_automate_router)
app.include_router(auth_router)
app.include_router(admin_router)


@app.get("/")
def read_root():
    return {"message": "SF2Dynamics backend is running"}


@app.get("/health")
def health():
    """Health check endpoint used by Docker and Azure Container Apps."""
    return {"status": "ok"}
