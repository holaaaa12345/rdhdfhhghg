import { BaseEntity } from './BaseEntity.js'

const splitSubjects = (value = '') =>
  String(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)

// We keep phone as a string (to preserve leading zeros), but restrict it to digits.
// Dominican phone numbers are commonly 8-10 digits, so we cap to 10.
const MAX_TEACHER_PHONE_DIGITS = 10
const sanitizeTeacherPhone = (value = '') =>
  String(value || '')
    .replace(/\D/g, '')
    .slice(0, MAX_TEACHER_PHONE_DIGITS)

export class TeacherEntity extends BaseEntity {
  constructor(data = {}) {
    super({
      id: data.id ?? null,
      name: data.name || '',
      email: data.email || '',
      phone: data.phone || '',
      subjects: data.subjects || '',
      subjectList: data.subjectList || splitSubjects(data.subjects),
      status: data.status || 'active',
      created_at: data.created_at || null,
    })
  }

  static fromRow(row = {}) {
    return new TeacherEntity(row)
  }

  static normalizeImportedRow(row = {}) {
    const normalized = {}
    Object.entries(row || {}).forEach(([key, value]) => {
      normalized[String(key).trim().toLowerCase()] = value
    })

    const subjects = String(
      normalized.asignaturas || normalized.asignatura || normalized.subjects || normalized.subject || '',
    )

    return {
      name: String(normalized.nombre || normalized.name || '').trim(),
      email: String(normalized.correo || normalized.email || '').trim(),
      phone: sanitizeTeacherPhone(normalized.telefono || normalized.phone || ''),
      subjects: splitSubjects(subjects).join(', '),
      status: String(normalized.estado || normalized.status || 'active').toLowerCase() === 'inactive'
        ? 'inactive'
        : 'active',
    }
  }

  static fromForm(data = {}, subjectList = []) {
    return new TeacherEntity({
      name: String(data.name || '').trim(),
      email: String(data.email || '').trim(),
      phone: sanitizeTeacherPhone(data.phone || ''),
      subjects: subjectList.join(', '),
      subjectList,
      status: data.status || 'active',
    })
  }

  toRow() {
    return {
      name: this.name,
      email: this.email || null,
      phone: this.phone || null,
      subjects: this.subjects,
      status: this.status,
    }
  }

  toExportRow() {
    return [
      this.name,
      this.email,
      this.phone,
      this.subjects,
      this.status === 'active' ? 'Activo' : 'Inactivo',
    ]
  }
}
