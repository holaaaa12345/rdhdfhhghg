import axios from 'axios'

// Todas las peticiones van a /api  →  vite.config.js lo redirige a FastAPI :8000
const api = axios.create({
  baseURL: '/api',
  headers: { 'Content-Type': 'application/json' },
})

// Adjunta token JWT en cada request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('access_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// Si el token expiró → redirige a login
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('access_token')
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)

// ── AUTH ─────────────────────────────────────────────────
export const authService = {
  login:  (email, password) => api.post('/auth/login', { email, password }),
  logout: ()                => api.post('/auth/logout'),
  me:     ()                => api.get('/auth/me'),
}

// ── USUARIOS / DOCENTES ───────────────────────────────────
export const usersService = {
  getAll:  ()          => api.get('/users'),
  getById: (id)        => api.get(`/users/${id}`),
  create:  (data)      => api.post('/users', data),
  update:  (id, data)  => api.put(`/users/${id}`, data),
  delete:  (id)        => api.delete(`/users/${id}`),
}

// ── DASHBOARD ─────────────────────────────────────────────
export const dashboardService = {
  getStats: () => api.get('/dashboard/stats'),
}

// ── ESTUDIANTES ───────────────────────────────────────────
export const studentsService = {
  getAll:  (course)   => api.get('/students', { params: { course } }),
  getById: (id)       => api.get(`/students/${id}`),
  create:  (data)     => api.post('/students', data),
  update:  (id, data) => api.put(`/students/${id}`, data),
  delete:  (id)       => api.delete(`/students/${id}`),
  import:  (formData) => api.post('/students/import', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }),
}

// ── CALIFICACIONES ────────────────────────────────────────
export const gradesService = {
  getByCourse:  (course, period) => api.get('/grades', { params: { course, period } }),
  saveBulk:     (data)           => api.post('/grades/bulk', data),
  addActivity:  (data)           => api.post('/grades/activity', data),
}

// ── ASISTENCIA ────────────────────────────────────────────
export const attendanceService = {
  get:  (course, date) => api.get('/attendance', { params: { course, date } }),
  save: (data)         => api.post('/attendance', data),
}

// ── PLANIFICACIÓN ─────────────────────────────────────────
export const planningService = {
  getAnnual:    (course, year) => api.get('/planning/annual', { params: { course, year } }),
  saveAnnual:   (data)         => api.post('/planning/annual', data),
  getVersions:  (planId)       => api.get(`/planning/versions/${planId}`),
  restoreVersion:(versionId)   => api.post(`/planning/restore/${versionId}`),
}

// ── NOTIFICACIONES POR CORREO ───────────────────────────────────────────────
export const notificationService = {
  sendRegistrationNotice: (data) => api.post('/notifications/register', data),
  sendRoleAssignedNotice: (data) => api.post('/notifications/role-assigned', data),
}

// Provisioning / Admin helpers (backend using Supabase service role key).
export const provisionService = {
  createAuthUser: (data) => api.post('/provision/auth-user', data),
}

export const planningShareService = {
  shareAnnualPlanning: (data) => api.post('/notifications/share-planning', data),
  shareAnnualPlanningPdf: (data) => api.post('/notifications/share-planning-pdf', data),
}

export default api
