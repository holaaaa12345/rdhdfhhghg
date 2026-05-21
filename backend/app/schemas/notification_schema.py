from pydantic import BaseModel, EmailStr
from typing import Optional


# Request: datos para notificar registro por correo.
class RegistrationNotificationRequest(BaseModel):
    name: str
    email: EmailStr


# Request: datos para notificar rol asignado por correo.
class RoleAssignedNotificationRequest(BaseModel):
    user_name: str
    user_email: EmailStr
    role: str
    assigned_by_name: Optional[str] = None
    assigned_by_email: Optional[EmailStr] = None


# Response estandar que devuelven los endpoints /notifications.
class EmailNotificationResponse(BaseModel):
    ok: bool
    message: str
    sent_count: int = 0


# Request: compartir/mandar una planificacion (matriz) por correo a Coordinador/Director.
class PlanningShareRequest(BaseModel):
    plan_type: str = "annual"
    subject: str
    course: str
    year: int
    plan_kind: str = "Tecnica"  # Tecnica o Academica (segun el centro)
    module_name: str = ""
    module_code: str = ""
    uc_code: str = ""
    uc_title: str = ""
    ra_title: str = ""
    ra_domain: str = ""
    shared_by_name: str = ""
    shared_by_email: Optional[EmailStr] = None
    # Link para abrir en la app (si aplica)
    app_link: Optional[str] = None


class PlanningSharePdfRequest(PlanningShareRequest):
    # PDF generado en frontend (base64). Se envia como adjunto en el correo.
    pdf_base64: str
    filename: str = "planificacion.pdf"
