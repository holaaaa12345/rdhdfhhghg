from pydantic import BaseModel, EmailStr, Field


class CreateAuthUserRequest(BaseModel):
    # Email del usuario que se va a crear en Supabase Auth.
    email: EmailStr
    # Contrasena inicial (temporal). En el frontend se usa el telefono del docente.
    password: str = Field(min_length=8, max_length=72)
    # Nombre para guardar en metadata/perfil.
    full_name: str = ""
    # Rol inicial del perfil. Por defecto Docente.
    role: str = "Docente"


class CreateAuthUserResponse(BaseModel):
    id: str
    email: EmailStr
