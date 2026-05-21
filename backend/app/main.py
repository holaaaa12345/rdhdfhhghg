from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routes import auth, users, dashboard, courses, notifications, provision

# Punto de entrada del backend (API).
# Esta app expone endpoints HTTP que consume el frontend.
# La base de datos y autenticacion estan en Supabase.
# El backend agrega cosas de servidor, por ejemplo envio de correos SMTP.

app = FastAPI(
    title=settings.app_name,
    version="2.0.0",
    description="API REST de EduPlan Pro — FastAPI + Supabase",
)

# ── CORS: permite peticiones desde el frontend React ──────────
# CORS: permite que el navegador deje al frontend llamar al backend.
# Sin CORS, el browser bloquea peticiones entre puertos o dominios distintos.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routers ───────────────────────────────────────────────────
# Routers: aqui se registran las rutas (endpoints) del sistema bajo el prefijo /api.
app.include_router(auth.router, prefix="/api")
app.include_router(users.router, prefix="/api")
app.include_router(dashboard.router, prefix="/api")
app.include_router(courses.router, prefix="/api")
app.include_router(notifications.router, prefix="/api")
app.include_router(provision.router, prefix="/api")

# ── Health check ──────────────────────────────────────────────
# Health check: endpoint simple para confirmar que el backend esta encendido.
@app.get("/")
async def root():
    return {"status": "ok", "app": settings.app_name}
