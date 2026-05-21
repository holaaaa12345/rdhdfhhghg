import { useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx-js-style'
import Modal from '../components/Modal.jsx'
import { buildSubjectOptions } from '../data/projectOptions.js'
import { teachersService } from '../services/academicServices.js'
import { provisionService } from '../services/api.js'

const initials = (name = '') => name.split(' ').map(part => part[0]).slice(0, 2).join('').toUpperCase()

// Phone is saved as text, but we enforce digits-only in the UI.
// In our context, "telefono" is used as the teacher number/contact number.
const MAX_TEACHER_PHONE_DIGITS = 10
const sanitizeTeacherPhone = (value) =>
  String(value || '')
    .replace(/\D/g, '')
    .slice(0, MAX_TEACHER_PHONE_DIGITS)

const emptyForm = () => ({
  name: '',
  email: '',
  phone: '',
  status: 'active',
})

const normalizeEmail = (value) => String(value || '').trim().toLowerCase()

const buildTempPassword = (phoneValue) => {
  const digits = String(phoneValue || '').replace(/\D/g, '')
  if (digits.length >= 8) return digits.slice(-8)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  let out = ''
  for (let i = 0; i < 10; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}

export default function Teachers({ showToast, onNavigate }) {
  const [teachers, setTeachers] = useState([])
  const [subjectOptions, setSubjectOptions] = useState(buildSubjectOptions())
  const [statusFilter, setStatusFilter] = useState('Todos')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)

  const [createModal, setCreateModal] = useState(false)
  const [viewModal, setViewModal] = useState(false)
  const [editModal, setEditModal] = useState(false)
  const [deleteModal, setDeleteModal] = useState(false)

  const [selected, setSelected] = useState(null)
  const [form, setForm] = useState(emptyForm())
  const [createAccessAccount, setCreateAccessAccount] = useState(false)
  const [subjectDraft, setSubjectDraft] = useState('')
  const [customSubjectDraft, setCustomSubjectDraft] = useState('')
  const [subjectList, setSubjectList] = useState([])

  const fileRef = useRef(null)

  useEffect(() => {
    fetchTeachers()
    fetchSubjectOptions()
  }, [])

  const fetchSubjectOptions = async () => {
    try {
      setSubjectOptions(await teachersService.fetchSubjectOptions())
    } catch (error) {
      console.error(error)
    }
  }

  const fetchTeachers = async () => {
    try {
      const data = await teachersService.list()
      setTeachers(data)
    } catch (error) {
      console.error(error)
      showToast('error', 'Error al cargar docentes')
    }
  }

  const filteredTeachers = useMemo(() => {
    const term = search.trim().toLowerCase()
    return teachers
      .filter(teacher => statusFilter === 'Todos' || teacher.status === statusFilter)
      .filter(teacher => {
        if (!term) return true
        return [teacher.name, teacher.email, teacher.phone, teacher.subjects]
          .filter(Boolean)
          .some(value => String(value).toLowerCase().includes(term))
      })
  }, [teachers, search, statusFilter])

  const setField = (field) => (event) => {
    const raw = event.target.value
    const value = field === 'phone' ? sanitizeTeacherPhone(raw) : raw
    setForm(prev => ({ ...prev, [field]: value }))
  }

  const resetForm = () => {
    setForm(emptyForm())
    setCreateAccessAccount(false)
    setSubjectDraft(subjectOptions[0] || '')
    setCustomSubjectDraft('')
    setSubjectList([])
  }

  const openCreate = () => {
    resetForm()
    setCreateModal(true)
  }

  const openView = (teacher) => {
    setSelected(teacher)
    setViewModal(true)
  }

  const openEdit = (teacher) => {
    setSelected(teacher)
    setForm({
      name: teacher.name || '',
      email: teacher.email || '',
      phone: teacher.phone || '',
      status: teacher.status || 'active',
    })
    setSubjectDraft(subjectOptions[0] || teacher.subjectList?.[0] || '')
    setCustomSubjectDraft('')
    setSubjectList(teacher.subjectList || [])
    setEditModal(true)
  }

  const openDelete = (teacher) => {
    setSelected(teacher)
    setDeleteModal(true)
  }

  const addSubject = () => {
    if (!subjectDraft.trim()) return
    const clean = subjectDraft.trim()
    setSubjectList(prev => (prev.includes(clean) ? prev : [...prev, clean]))
  }

  const addCustomSubject = () => {
    if (!customSubjectDraft.trim()) return
    const clean = customSubjectDraft.trim()
    setSubjectList(prev => (prev.includes(clean) ? prev : [...prev, clean]))
    setCustomSubjectDraft('')
  }

  const removeSubject = (subject) => {
    setSubjectList(prev => prev.filter(item => item !== subject))
  }

  const validateForm = () => {
    if (!form.name.trim()) {
      showToast('error', 'El nombre del docente es obligatorio')
      return false
    }

    if (form.phone) {
      // Common formats are 8 digits (local) or 10 digits (with area code).
      if (form.phone.length < 8) {
        showToast('warning', 'El telefono debe tener al menos 8 digitos (solo numeros).')
        return false
      }
      if (form.phone.length > MAX_TEACHER_PHONE_DIGITS) {
        showToast('warning', `El telefono no puede pasar de ${MAX_TEACHER_PHONE_DIGITS} digitos.`)
        return false
      }
    }

    if (subjectList.length === 0) {
      showToast('warning', 'Agrega al menos una asignatura')
      return false
    }
    return true
  }

  const handleCreate = async () => {
    if (!validateForm()) return
    setLoading(true)
    try {
      const email = normalizeEmail(form.email)

      if (createAccessAccount) {
        if (!email) {
          showToast('error', 'Para crear acceso, el correo es obligatorio.')
          return
        }

        // Validar ANTES de crear el usuario en Auth (si ya existe, paramos aqui).
        await teachersService.assertTeacherEmailAvailable(email)

        const tempPassword = buildTempPassword(form.phone)
        await provisionService.createAuthUser({
          email,
          password: tempPassword,
          full_name: form.name,
          role: 'Docente',
        })

        showToast('success', `Acceso creado: ${email} | Password temporal: ${tempPassword}`)
      }

      // Si acabamos de crear el Auth user, ahora ya existira en profiles; evitamos bloquear por eso.
      await teachersService.createFromForm({ ...form, email, __skipProfileCheck: Boolean(createAccessAccount) }, subjectList)
      showToast('success', 'Docente registrado')
      setCreateModal(false)
      resetForm()
      fetchTeachers()
      fetchSubjectOptions()
    } catch (error) {
      console.error(error)
      const msg = String(error?.response?.data?.detail || error?.message || '')
      if (msg) {
        showToast('error', msg)
      } else {
        showToast('error', 'Error al registrar docente')
      }
    } finally {
      setLoading(false)
    }
  }

  const handleEdit = async () => {
    if (!selected) return
    if (!validateForm()) return
    setLoading(true)
    try {
      await teachersService.updateFromForm(selected.id, form, subjectList)
      showToast('success', 'Docente actualizado')
      setEditModal(false)
      fetchTeachers()
      fetchSubjectOptions()
    } catch (error) {
      console.error(error)
      showToast('error', 'Error al actualizar docente')
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async () => {
    if (!selected) return
    try {
      await teachersService.delete(selected.id)
      setDeleteModal(false)
      setSelected(null)
      showToast('success', 'Docente eliminado')
      fetchTeachers()
      fetchSubjectOptions()
    } catch (error) {
      console.error(error)
      showToast('error', 'Error al eliminar docente')
    }
  }

  const handleExport = () => {
    const now = new Date()
    const title = 'EduNova - Listado de Docentes'
    const subtitle = `Generado: ${now.toLocaleDateString('es')}`

    const borderThin = {
      top: { style: 'thin', color: { rgb: 'E5E7EB' } },
      bottom: { style: 'thin', color: { rgb: 'E5E7EB' } },
      left: { style: 'thin', color: { rgb: 'E5E7EB' } },
      right: { style: 'thin', color: { rgb: 'E5E7EB' } },
    }

    const styles = {
      title: {
        font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 13 },
        alignment: { horizontal: 'center', vertical: 'center' },
        fill: { patternType: 'solid', fgColor: { rgb: '2563EB' } },
      },
      subtitle: {
        font: { color: { rgb: '111827' }, sz: 10 },
        alignment: { horizontal: 'center', vertical: 'center' },
        fill: { patternType: 'solid', fgColor: { rgb: 'F3F4F6' } },
      },
      header: {
        font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 10 },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        fill: { patternType: 'solid', fgColor: { rgb: '111827' } },
        border: borderThin,
      },
      cell: {
        font: { color: { rgb: '111827' }, sz: 10 },
        alignment: { vertical: 'center', wrapText: true },
        border: borderThin,
      },
      zebra: { fill: { patternType: 'solid', fgColor: { rgb: 'FAFAFA' } } },
    }

    const headers = ['Nombre', 'Correo', 'Telefono', 'Asignaturas', 'Estado']
    const rows = filteredTeachers.map(teacher => teacher.toExportRow())

    const wsData = []
    wsData.push(headers.map((_, i) => ({ v: i === 0 ? title : '', t: 's', s: styles.title })))
    wsData.push(headers.map((_, i) => ({ v: i === 0 ? subtitle : '', t: 's', s: styles.subtitle })))
    wsData.push(headers.map(() => ''))
    wsData.push(headers.map(h => ({ v: h, t: 's', s: styles.header })))

    rows.forEach((row, idx) => {
      wsData.push(row.map((value, colIdx) => ({
        v: value ?? '',
        t: 's',
        s: { ...styles.cell, ...(idx % 2 === 1 ? styles.zebra : {}) },
      })))
    })

    const ws = XLSX.utils.aoa_to_sheet(wsData)
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: headers.length - 1 } },
    ]
    ws['!cols'] = [{ wch: 26 }, { wch: 30 }, { wch: 14 }, { wch: 38 }, { wch: 12 }]
    ws['!rows'] = [{ hpt: 24 }, { hpt: 18 }]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Docentes')
    XLSX.writeFile(wb, `docentes_${now.toISOString().slice(0, 10)}.xlsx`)
    showToast('success', 'Listado de docentes exportado')
  }

  const handleImport = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    setImporting(true)
    try {
      const buffer = await file.arrayBuffer()
      const workbook = XLSX.read(buffer, { type: 'array' })
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]]
      const rawRows = XLSX.utils.sheet_to_json(firstSheet, { defval: '' })

      const imported = await teachersService.importRows(rawRows)
      if (imported.length === 0) {
        showToast('warning', 'El archivo no contiene docentes validos')
        return
      }

      showToast('success', `${imported.length} docentes importados correctamente`)
      fetchTeachers()
      fetchSubjectOptions()
    } catch (error) {
      console.error(error)
      showToast('error', 'Error al importar docentes')
    } finally {
      setImporting(false)
      event.target.value = ''
    }
  }

  const activeTeachers = teachers.filter(teacher => teacher.status === 'active').length
  const totalSubjects = new Set(teachers.flatMap(teacher => teacher.subjectList)).size

  const renderSubjectEditor = () => (
    <>
      <div className="form-group">
        <label>Asignaturas</label>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <select className="form-control" value={subjectDraft} onChange={event => setSubjectDraft(event.target.value)}>
            <option value="">Selecciona una asignatura</option>
            {subjectOptions.map(subject => <option key={subject} value={subject}>{subject}</option>)}
          </select>
          <button type="button" className="btn btn-primary btn-sm" onClick={addSubject}>
            <i className="fas fa-plus" />Agregar
          </button>
        </div>
      </div>

      <div className="form-group" style={{ marginTop: '0.75rem' }}>
        <label>Otra asignatura (si no aparece en la lista)</label>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            className="form-control"
            value={customSubjectDraft}
            onChange={(event) => setCustomSubjectDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              addCustomSubject()
            }}
            placeholder="Escribe la asignatura (ej: Informatica, Formacion Humana...)"
          />
          <button type="button" className="btn btn-secondary btn-sm" onClick={addCustomSubject} title="Agregar asignatura personalizada">
            <i className="fas fa-plus" />Agregar
          </button>
        </div>
        <div style={{ fontSize: '0.76rem', color: '#6b7280', marginTop: 6 }}>
          Esto no elimina las asignaturas predefinidas; solo te deja agregar una nueva si hace falta.
        </div>
      </div>

      {subjectList.length > 0 && (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
          {subjectList.map(subject => (
            <span
              key={subject}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '0.45rem 0.7rem',
                borderRadius: 999,
                background: 'rgba(37,99,235,0.08)',
                color: 'var(--primary)',
                fontSize: '0.82rem',
                fontWeight: 600,
              }}
            >
              {subject}
              <button
                type="button"
                onClick={() => removeSubject(subject)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}
              >
                <i className="fas fa-times" />
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  )

  return (
    <section>
      <div className="page-header">
        <div className="breadcrumb"><a onClick={() => onNavigate('dashboard')}>Inicio</a><span>/</span><span>Docentes</span></div>
        <h2>Gestion de Docentes</h2>
        <p>Administra el personal docente con operaciones completas de registro, consulta, edicion, eliminacion e importacion.</p>
      </div>

      <div className="stats-grid">
        {[
          { i: 'fa-chalkboard-teacher', c: 'blue', v: teachers.length, l: 'Total docentes' },
          { i: 'fa-user-check', c: 'green', v: activeTeachers, l: 'Activos' },
          { i: 'fa-book-open', c: 'purple', v: totalSubjects, l: 'Asignaturas' },
          { i: 'fa-filter', c: 'orange', v: filteredTeachers.length, l: 'Resultados' },
        ].map(item => (
          <div className="stat-card" key={item.l}>
            <div className={`icon ${item.c}`}><i className={`fas ${item.i}`} /></div>
            <div className="value">{item.v}</div>
            <div className="label">{item.l}</div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-header">
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <select className="form-control" style={{ width: 'auto' }} value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
              <option value="Todos">Todos</option>
              <option value="active">Activos</option>
              <option value="inactive">Inactivos</option>
            </select>

            <div style={{ display: 'flex', alignItems: 'center', background: '#f3f4f6', borderRadius: 8, padding: '0.4rem 0.75rem', gap: 6 }}>
              <i className="fas fa-search" style={{ color: '#9ca3af', fontSize: '0.8rem' }} />
              <input
                placeholder="Buscar docente..."
                value={search}
                onChange={event => setSearch(event.target.value)}
                style={{ border: 'none', background: 'none', outline: 'none', fontSize: '0.85rem', width: 170 }}
              />
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              style={{ display: 'none' }}
              onChange={handleImport}
            />
            <button className="btn btn-secondary" disabled={importing} onClick={() => fileRef.current?.click()}>
              {importing
                ? <><i className="fas fa-spinner fa-spin" />Importando...</>
                : <><i className="fas fa-file-import" />Importar Excel</>}
            </button>
            <button className="btn btn-secondary" onClick={handleExport}>
              <i className="fas fa-file-export" />Exportar Excel
            </button>
            <button className="btn btn-primary" onClick={openCreate}>
              <i className="fas fa-plus" />Nuevo Docente
            </button>
          </div>
        </div>

        <div className="card-body" style={{ overflowX: 'auto' }}>
          {filteredTeachers.length === 0 ? (
            <div className="empty-state">
              <i className="fas fa-chalkboard-teacher" />
              <h3>No hay docentes registrados</h3>
              <p>Agrega docentes manualmente o importa una lista para completar la gestion academica.</p>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Docente</th>
                  <th>Contacto</th>
                  <th>Asignaturas</th>
                  <th>Estado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {filteredTeachers.map(teacher => (
                  <tr key={teacher.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div className="user-avatar" style={{ width: 36, height: 36, fontSize: '0.8rem' }}>{initials(teacher.name)}</div>
                        <div>
                          <strong>{teacher.name}</strong>
                          <div style={{ fontSize: '0.78rem', color: '#6b7280' }}>{teacher.phone || 'Sin telefono'}</div>
                        </div>
                      </div>
                    </td>
                    <td><div style={{ fontSize: '0.84rem' }}>{teacher.email || 'Sin correo'}</div></td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {teacher.subjectList.length > 0
                          ? teacher.subjectList.map(subject => <span key={subject} className="status-badge pending">{subject}</span>)
                          : <span style={{ color: '#9ca3af', fontSize: '0.82rem' }}>Sin asignaturas</span>}
                      </div>
                    </td>
                    <td>
                      <span className={`status-badge ${teacher.status === 'active' ? 'active' : 'danger'}`}>
                        {teacher.status === 'active' ? 'Activo' : 'Inactivo'}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: '0.4rem' }}>
                        <button className="btn btn-sm btn-secondary" onClick={() => openView(teacher)} title="Ver"><i className="fas fa-eye" /></button>
                        <button className="btn btn-sm btn-secondary" onClick={() => openEdit(teacher)} title="Editar"><i className="fas fa-edit" /></button>
                        <button className="btn btn-sm btn-secondary" style={{ color: 'var(--danger)' }} onClick={() => openDelete(teacher)} title="Eliminar"><i className="fas fa-trash" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {createModal && (
        <Modal title="Registrar Nuevo Docente" icon="fa-chalkboard-teacher" onClose={() => setCreateModal(false)}
          footer={<>
            <button className="btn btn-secondary" onClick={() => setCreateModal(false)}>Cancelar</button>
            <button className="btn btn-primary" onClick={handleCreate} disabled={loading}>
              <i className={`fas ${loading ? 'fa-spinner fa-spin' : 'fa-save'}`} />
              {loading ? 'Guardando...' : 'Guardar'}
            </button>
          </>}>
          <div className="grid-2">
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label>Nombre completo *</label>
              <input className="form-control" value={form.name} onChange={setField('name')} placeholder="Maria Perez" />
            </div>
            <div className="form-group">
              <label>Correo</label>
              <input type="email" className="form-control" value={form.email} onChange={setField('email')} placeholder="docente@colegio.com" />
            </div>
            <div className="form-group">
              <label>Telefono</label>
              <input
                className="form-control"
                type="tel"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={MAX_TEACHER_PHONE_DIGITS}
                value={form.phone}
                onChange={setField('phone')}
                placeholder="70000000"
              />
              <div style={{ fontSize: '0.76rem', color: '#6b7280', marginTop: 6 }}>
                Solo numeros. Maximo {MAX_TEACHER_PHONE_DIGITS} digitos.
              </div>
            </div>
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input
                  type="checkbox"
                  checked={createAccessAccount}
                  onChange={(e) => setCreateAccessAccount(e.target.checked)}
                />
                Crear cuenta de acceso para iniciar sesion (correo + password temporal)
              </label>
              <div style={{ fontSize: '0.76rem', color: '#6b7280', marginTop: 6 }}>
                Si activas esto, el sistema crea el usuario en Supabase Auth. El password temporal se genera con los ultimos 8 digitos del telefono (o uno aleatorio si no hay telefono).
              </div>
            </div>
            <div className="form-group">
              <label>Estado</label>
              <select className="form-control" value={form.status} onChange={setField('status')}>
                <option value="active">Activo</option>
                <option value="inactive">Inactivo</option>
              </select>
            </div>
          </div>
          {renderSubjectEditor()}
        </Modal>
      )}

      {viewModal && selected && (
        <Modal title="Detalle del Docente" icon="fa-eye" onClose={() => setViewModal(false)}
          footer={<>
            <button className="btn btn-secondary" onClick={() => setViewModal(false)}>Cerrar</button>
            <button className="btn btn-primary" onClick={() => { setViewModal(false); openEdit(selected) }}>
              <i className="fas fa-edit" />Editar
            </button>
          </>}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '1rem' }}>
            <div className="user-avatar" style={{ width: 48, height: 48 }}>{initials(selected.name)}</div>
            <div>
              <p style={{ fontWeight: 700 }}>{selected.name}</p>
              <p style={{ fontSize: '0.82rem', color: '#6b7280' }}>{selected.email || 'Sin correo registrado'}</p>
            </div>
          </div>
          <div className="grid-2">
            <div style={{ background: '#f3f4f6', padding: '0.8rem', borderRadius: 10 }}>
              <p style={{ fontSize: '0.72rem', color: '#9ca3af' }}>TELEFONO</p>
              <p style={{ fontWeight: 600 }}>{selected.phone || 'Sin telefono'}</p>
            </div>
            <div style={{ background: '#f3f4f6', padding: '0.8rem', borderRadius: 10 }}>
              <p style={{ fontSize: '0.72rem', color: '#9ca3af' }}>ESTADO</p>
              <p style={{ fontWeight: 600 }}>{selected.status === 'active' ? 'Activo' : 'Inactivo'}</p>
            </div>
          </div>
          <div style={{ marginTop: '1rem' }}>
            <p style={{ fontSize: '0.75rem', color: '#9ca3af', marginBottom: '0.5rem' }}>ASIGNATURAS</p>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {selected.subjectList.length > 0
                ? selected.subjectList.map(subject => <span key={subject} className="status-badge pending">{subject}</span>)
                : <span style={{ color: '#9ca3af', fontSize: '0.82rem' }}>Sin asignaturas registradas</span>}
            </div>
          </div>
        </Modal>
      )}

      {editModal && selected && (
        <Modal title="Editar Docente" icon="fa-edit" iconColor="var(--warning)" onClose={() => setEditModal(false)}
          footer={<>
            <button className="btn btn-secondary" onClick={() => setEditModal(false)}>Cancelar</button>
            <button className="btn btn-primary" onClick={handleEdit} disabled={loading}>
              <i className={`fas ${loading ? 'fa-spinner fa-spin' : 'fa-save'}`} />
              {loading ? 'Guardando...' : 'Actualizar'}
            </button>
          </>}>
          <div className="grid-2">
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label>Nombre completo *</label>
              <input className="form-control" value={form.name} onChange={setField('name')} />
            </div>
            <div className="form-group">
              <label>Correo</label>
              <input type="email" className="form-control" value={form.email} onChange={setField('email')} />
            </div>
            <div className="form-group">
              <label>Telefono</label>
              <input
                className="form-control"
                type="tel"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={MAX_TEACHER_PHONE_DIGITS}
                value={form.phone}
                onChange={setField('phone')}
              />
              <div style={{ fontSize: '0.76rem', color: '#6b7280', marginTop: 6 }}>
                Solo numeros. Maximo {MAX_TEACHER_PHONE_DIGITS} digitos.
              </div>
            </div>
            <div className="form-group">
              <label>Estado</label>
              <select className="form-control" value={form.status} onChange={setField('status')}>
                <option value="active">Activo</option>
                <option value="inactive">Inactivo</option>
              </select>
            </div>
          </div>
          {renderSubjectEditor()}
        </Modal>
      )}

      {deleteModal && selected && (
        <Modal title="Eliminar Docente" icon="fa-trash" iconColor="var(--danger)" onClose={() => setDeleteModal(false)}
          footer={<>
            <button className="btn btn-secondary" onClick={() => setDeleteModal(false)}>Cancelar</button>
            <button className="btn btn-danger" onClick={handleDelete}><i className="fas fa-trash" />Eliminar</button>
          </>}>
          <p>¿Seguro que deseas eliminar a <strong>{selected.name}</strong>?</p>
          <p style={{ color: '#6b7280', fontSize: '0.85rem', marginTop: '0.5rem' }}>
            Este cambio removerá sus datos del catálogo docente.
          </p>
        </Modal>
      )}
    </section>
  )
}
