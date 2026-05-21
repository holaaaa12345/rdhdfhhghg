from fastapi import APIRouter, HTTPException

from app.schemas.provision_schema import CreateAuthUserRequest, CreateAuthUserResponse
from app.services.supabase_service import supabase
from app.services.email_service import email_service

router = APIRouter(prefix="/provision", tags=["Provision"])


@router.post("/auth-user", response_model=CreateAuthUserResponse, status_code=201)
async def create_auth_user(body: CreateAuthUserRequest):
    """
    Crea un usuario directamente en Supabase Auth (modo admin).

    Caso de uso en EduNova:
    - El Director registra un docente desde el modulo "Docentes"
    - Si ese docente aun no tiene cuenta, el sistema puede crearle la cuenta de acceso
      para que luego inicie sesion con su correo y una contrasena temporal.

    Nota:
    - Esto requiere SUPABASE_SERVICE_KEY en backend/.env
    """

    email = str(body.email).strip().lower()
    password = str(body.password)
    full_name = str(body.full_name or "").strip()
    role = str(body.role or "Docente").strip() or "Docente"

    try:
        auth_response = supabase.auth.admin.create_user(
            {
                "email": email,
                "password": password,
                "email_confirm": True,
                "user_metadata": {"full_name": full_name},
            }
        )
    except Exception as error:
        msg = str(error)
        # Cuando falta SUPABASE_SERVICE_KEY (service role), Supabase responde este error.
        if "valid bearer token" in msg.lower():
            raise HTTPException(
                status_code=400,
                detail="Falta SUPABASE_SERVICE_KEY (service role key) en backend/.env para crear usuarios.",
            )
        # Mensaje tipico cuando el email ya existe.
        if "already" in msg.lower() and "user" in msg.lower():
            raise HTTPException(status_code=409, detail="El correo ya esta registrado en el sistema")
        raise HTTPException(status_code=400, detail=msg)

    if not getattr(auth_response, "user", None):
        raise HTTPException(status_code=400, detail="No se pudo crear el usuario en Supabase Auth")

    uid = auth_response.user.id

    # Asegura/actualiza perfil con rol inicial (bypass RLS por service key).
    # Si existe un trigger de profiles, esto solo lo refuerza.
    try:
        supabase.table("profiles").upsert(
            {
                "id": uid,
                "email": email,
                "full_name": full_name,
                "role": role,
                "status": "active",
            }
        ).execute()
    except Exception:
        # No bloqueamos la creacion por problemas de perfil; el usuario existe igual.
        pass

    # Enviar correo al docente con sus credenciales temporales (si SMTP esta configurado).
    try:
        if email_service.is_configured:
            subject = "Tu acceso a EduNova fue creado"
            html = f"""
            <h2>Hola, {full_name or email}</h2>
            <p>Tu cuenta de acceso a <strong>EduNova</strong> ya fue creada.</p>
            <p><strong>Correo:</strong> {email}</p>
            <p><strong>Contrasena temporal:</strong> {password}</p>
            <p>Entra al sistema y cambia tu contrasena cuando puedas.</p>
            """
            email_service.send_email(
                recipient_email=email,
                subject=subject,
                html_body=html,
            )
    except Exception:
        # No bloqueamos el alta por fallos de correo.
        pass

    return CreateAuthUserResponse(id=uid, email=email)
