import { supabase } from './supabaseClient.js'
import { buildSubjectOptions, buildTeacherOptions } from '../data/projectOptions.js'
import { BaseCrudService } from './core/BaseCrudService.js'
import { StudentEntity } from '../domain/entities/StudentEntity.js'
import { TeacherEntity } from '../domain/entities/TeacherEntity.js'
import { CourseEntity } from '../domain/entities/CourseEntity.js'

const normalizeEmail = (value) => String(value || '').trim().toLowerCase()

const isMissingColumn = (error, column = 'user_id') => {
  const code = String(error?.code || '')
  const message = String(error?.message || '').toLowerCase()
  const details = String(error?.details || '').toLowerCase()
  const combined = `${code} ${message} ${details}`
  return combined.includes('42703') || (combined.includes('column') && combined.includes(column) && combined.includes('does not exist'))
}

class StudentsService extends BaseCrudService {
  constructor() {
    super({ client: supabase, tableName: 'students', entityClass: StudentEntity })
  }

  async fetchNextStudentCodeIndex() {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) throw new Error('Usuario no autenticado')

    let rows = []
    // Prefer per-user code numbering when `user_id` exists.
    {
      const res = await supabase
        .from('students')
        .select('code')
        .eq('user_id', user.id)
      if (res.error && !isMissingColumn(res.error, 'user_id')) throw res.error
      rows = res.error ? [] : (res.data || [])
    }

    // Backward compatibility (older schema without user_id).
    if (rows.length === 0) {
      const res = await supabase
        .from('students')
        .select('code')
      if (res.error) throw res.error
      rows = res.data || []
    }

    const max = (rows || [])
      .map(row => StudentEntity.parseCodeIndex(row.code))
      .filter((value) => Number.isFinite(value))
      .reduce((acc, value) => Math.max(acc, value), 0)

    return max + 1
  }

  async fetchCourseOptions() {
    const { data, error } = await supabase
      .from('courses')
      .select('code, name')
      .order('created_at', { ascending: true })
    if (error) throw error

    const codes = (data || []).map(row => String(row.code || '').trim()).filter(Boolean)
    return Array.from(new Set(codes)).sort((a, b) => a.localeCompare(b, 'es'))
  }

  async createFromForm(form, { fallbackCourse = '' } = {}) {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) throw new Error('Usuario no autenticado')

    // Generate a unique sequential code based on what already exists in Supabase.
    // We retry on unique violation in case two requests happen at the same time.
    const baseIndex = await this.fetchNextStudentCodeIndex()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const forcedCode = StudentEntity.buildCodeFromIndex(baseIndex + attempt)
      const entity = StudentEntity.fromForm(form, { fallbackCourse, forcedCode })
      try {
        const payloadWithUser = { ...entity.toRow(), user_id: user.id }
        const res = await supabase.from('students').insert([payloadWithUser]).select().single()

        // Backward compatibility (older schema without user_id).
        if (res.error && isMissingColumn(res.error, 'user_id')) {
          const legacy = await supabase.from('students').insert([entity.toRow()]).select().single()
          if (legacy.error) throw legacy.error
          return StudentEntity.fromRow(legacy.data)
        }

        if (res.error) throw res.error
        return StudentEntity.fromRow(res.data)
      } catch (error) {
        const msg = String(error?.message || '')
        if (msg.includes('students_code_key') || msg.includes('duplicate key')) {
          continue
        }
        throw error
      }
    }
    throw new Error('No se pudo generar un código único para el estudiante. Intenta de nuevo.')
  }

  async updateFromForm(id, form, { fallbackCourse = '', forcedCode } = {}) {
    const entity = StudentEntity.fromForm(form, { fallbackCourse, forcedCode })
    return this.update(id, entity)
  }

  async importRows(rawRows = [], { fallbackCourse = '' } = {}) {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) throw new Error('Usuario no autenticado')

    const baseIndex = await this.fetchNextStudentCodeIndex()
    const payloadBase = rawRows
      .map(row => StudentEntity.normalizeImportedRow(row, fallbackCourse))
      .filter(row => row.name)
      .map((row, index) => StudentEntity.fromForm(row, {
        fallbackCourse,
        forcedCode: StudentEntity.buildCodeFromIndex(baseIndex + index),
      }).toRow())

    if (payloadBase.length === 0) return []

    // Prefer schema with user_id; fallback to legacy schema.
    const payloadWithUser = payloadBase.map(row => ({ ...row, user_id: user.id }))
    const res = await supabase.from('students').insert(payloadWithUser).select()
    if (res.error && isMissingColumn(res.error, 'user_id')) {
      const legacy = await supabase.from('students').insert(payloadBase).select()
      if (legacy.error) throw legacy.error
      return this.mapRows(legacy.data || [])
    }
    if (res.error) throw res.error
    return this.mapRows(res.data || [])
  }
}

class TeachersService extends BaseCrudService {
  constructor() {
    super({ client: supabase, tableName: 'teachers', entityClass: TeacherEntity })
  }

  async assertTeacherEmailAvailable(email, { excludeId, skipProfileCheck = false } = {}) {
    const normalized = normalizeEmail(email)
    if (!normalized) return

    // 1) Block using an email that already exists as an Auth/Profile user.
    // During "create access account" flow, we purposely create the Auth user first,
    // so we skip this check on the final teachers insert.
    if (!skipProfileCheck) {
      const profileRes = await supabase
        .from('profiles')
        .select('id')
        .eq('email', normalized)
        .maybeSingle()

      if (profileRes.error) throw profileRes.error
      if (profileRes.data?.id) {
        throw new Error('Ese correo ya esta registrado como usuario en el sistema. Usa otro correo.')
      }
    }

    // 2) Prevent duplicates inside the teachers catalog too.
    let teacherQuery = supabase
      .from('teachers')
      .select('id, email')
      .ilike('email', normalized)

    if (excludeId) teacherQuery = teacherQuery.neq('id', excludeId)

    const teacherRes = await teacherQuery.maybeSingle()
    if (teacherRes.error) throw teacherRes.error
    if (teacherRes.data?.id) {
      throw new Error('Ese correo ya esta registrado en el catalogo de docentes.')
    }
  }

  async fetchSubjectOptions() {
    const [{ data: courses }, { data: teacherRows }] = await Promise.all([
      supabase.from('courses').select('code, name').order('created_at', { ascending: true }),
      supabase.from('teachers').select('subjects').order('created_at', { ascending: true }),
    ])

    return buildSubjectOptions({
      courses: courses || [],
      teachers: teacherRows || [],
    })
  }

  async fetchTeacherOptions() {
    const { data, error } = await supabase
      .from('teachers')
      .select('name')
      .order('name', { ascending: true })
    if (error) throw error
    return buildTeacherOptions(data || [])
  }

  async createFromForm(form, subjectList = []) {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) throw new Error('Usuario no autenticado')
    const entity = TeacherEntity.fromForm(form, subjectList)

    const skipProfileCheck = Boolean(form?.__skipProfileCheck)
    await this.assertTeacherEmailAvailable(entity.email, { skipProfileCheck })
    entity.email = normalizeEmail(entity.email) || entity.email

    const res = await supabase.from('teachers').insert([{ ...entity.toRow(), user_id: user.id }]).select().single()
    if (res.error && isMissingColumn(res.error, 'user_id')) {
      const legacy = await supabase.from('teachers').insert([entity.toRow()]).select().single()
      if (legacy.error) throw legacy.error
      return TeacherEntity.fromRow(legacy.data)
    }
    if (res.error) throw res.error
    return TeacherEntity.fromRow(res.data)
  }

  async updateFromForm(id, form, subjectList = []) {
    const entity = TeacherEntity.fromForm(form, subjectList)
    await this.assertTeacherEmailAvailable(entity.email, { excludeId: id, skipProfileCheck: Boolean(form?.__skipProfileCheck) })
    entity.email = normalizeEmail(entity.email) || entity.email
    return this.update(id, entity)
  }

  async importRows(rawRows = []) {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) throw new Error('Usuario no autenticado')

    const payload = rawRows
      .map(row => TeacherEntity.normalizeImportedRow(row))
      .filter(row => row.name)
    if (payload.length === 0) return []

    // Validate emails (fail fast with a clear message).
    for (const row of payload) {
      await this.assertTeacherEmailAvailable(row.email)
      row.email = normalizeEmail(row.email) || row.email
    }

    const withUser = payload.map(row => ({ ...row, user_id: user.id }))
    const res = await supabase.from('teachers').insert(withUser).select()
    if (res.error && isMissingColumn(res.error, 'user_id')) {
      const legacy = await supabase.from('teachers').insert(payload).select()
      if (legacy.error) throw legacy.error
      return this.mapRows(legacy.data || [])
    }
    if (res.error) throw res.error
    return this.mapRows(res.data || [])
  }
}

class CoursesService extends BaseCrudService {
  constructor() {
    super({ client: supabase, tableName: 'courses', entityClass: CourseEntity })
  }

  async fetchCourseCodes() {
    const { data, error } = await supabase
      .from('courses')
      .select('code')
      .order('created_at', { ascending: true })
    if (error) throw error
    const codes = (data || []).map(row => String(row.code || '').trim()).filter(Boolean)
    return Array.from(new Set(codes)).sort((a, b) => a.localeCompare(b, 'es'))
  }

  async listStudents(courseCode, { ownerUserId } = {}) {
    let query = supabase
      .from('students')
      .select('id, code, name')
      .eq('course', courseCode)
      .order('name', { ascending: true })

    if (ownerUserId) {
      query = query.eq('user_id', ownerUserId)
    }

    const { data, error } = await query

    // Backward compatibility: old schema has no user_id.
    if (error && ownerUserId && isMissingColumn(error, 'user_id')) {
      const legacy = await supabase
        .from('students')
        .select('id, code, name')
        .eq('course', courseCode)
        .order('name', { ascending: true })
      if (legacy.error) throw legacy.error
      return legacy.data || []
    }

    if (error) throw error
    return data || []
  }

  async createFromForm(form) {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) throw new Error('Usuario no autenticado')

    const entity = CourseEntity.fromForm(form)
    const res = await supabase.from('courses').insert([{ ...entity.toRow(), user_id: user.id }]).select().single()
    if (res.error && isMissingColumn(res.error, 'user_id')) {
      const legacy = await supabase.from('courses').insert([entity.toRow()]).select().single()
      if (legacy.error) throw legacy.error
      return CourseEntity.fromRow(legacy.data)
    }
    if (res.error) throw res.error
    return CourseEntity.fromRow(res.data)
  }

  async updateFromForm(id, form) {
    return this.update(id, CourseEntity.fromForm(form))
  }
}

export const studentsService = new StudentsService()
export const teachersService = new TeachersService()
export const coursesService = new CoursesService()
