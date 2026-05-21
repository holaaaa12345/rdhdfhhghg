import { useState, useEffect } from 'react'
import { supabase } from '../services/supabaseClient.js'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import * as XLSX from 'xlsx-js-style'
import { ACADEMIC_SUBJECT_OPTIONS, buildAcademicCourse } from '../data/projectOptions.js'
import { studentsService } from '../services/academicServices.js'
import { toISODateLocal } from '../utils/dateUtils.js'

const STATUS_COLOR = { present: 'var(--success)', absent: 'var(--danger)', late: 'var(--warning)' }
const STATUS_ICON = { present: 'fa-check-circle', absent: 'fa-times-circle', late: 'fa-clock' }
const STATUS_LABEL = { present: 'Presente', absent: 'Ausente', late: 'Tardanza' }

export function Attendance({ showToast, onNavigate }) {
  const [subject, setSubject] = useState(ACADEMIC_SUBJECT_OPTIONS[0] || '')
  const [courseOptions, setCourseOptions] = useState([])
  const [section, setSection] = useState('')
  const [date, setDate] = useState(toISODateLocal(new Date()))
  const [att, setAtt] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [exporting, setExporting] = useState(false)
  const course = buildAcademicCourse(subject, section)

  useEffect(() => {
    ;(async () => {
      try {
        const codes = await studentsService.fetchCourseOptions()
        setCourseOptions(codes)
        setSection((current) => current || codes[0] || '')
      } catch (err) {
        console.error(err)
      }
    })()
  }, [])

  useEffect(() => {
    fetchAttendance()
  }, [course, date])

  const fetchAttendance = async () => {
    setLoading(true)
    setSaved(false)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('Usuario no autenticado')
      if (!String(section || '').trim()) {
        setAtt([])
        return
      }

      const { data: studentsData, error: studentsError } = await supabase
        .from('students')
        .select('id, name')
        .eq('course', section)
        .order('name', { ascending: true })
      if (studentsError) throw studentsError

      const { data, error } = await supabase
        .from('attendance')
        .select('*')
        .eq('user_id', user.id)
        .eq('course', course)
        .eq('date', date)
      if (error) throw error

      const rows = (studentsData || []).map(student => {
        const rec = (data || []).find(r => r.student_name === student.name)
        return {
          n: student.name,
          s: rec ? rec.status : 'present',
          j: rec ? rec.justified : false,
          o: rec ? rec.observation : '',
        }
      })

      setAtt(rows)
    } catch (error) {
      console.error(error)
      showToast('error', 'Error al cargar asistencia')
    } finally {
      setLoading(false)
    }
  }

  const setS = (i, s) => { setSaved(false); setAtt(p => p.map((x, j) => j === i ? { ...x, s } : x)) }
  const togJ = i => { setSaved(false); setAtt(p => p.map((x, j) => j === i ? { ...x, j: !x.j } : x)) }
  const setO = (i, o) => { setSaved(false); setAtt(p => p.map((x, j) => j === i ? { ...x, o } : x)) }
  const markAll = () => { setSaved(false); setAtt(p => p.map(x => ({ ...x, s: 'present' }))) }
  const markAllAbsent = () => { setSaved(false); setAtt(p => p.map(x => ({ ...x, s: 'absent' }))) }

  const handleSave = async () => {
    setSaving(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('Usuario no autenticado')
      if (!String(section || '').trim()) {
        showToast('warning', 'Primero crea un curso en "Cursos y Secciones" y selecciónalo para registrar asistencia.')
        return
      }

      const upserts = att.map(a => ({
        user_id: user.id,
        course,
        date,
        student_name: a.n,
        status: a.s,
        justified: a.j,
        observation: a.o || '',
        updated_at: new Date().toISOString(),
      }))

      const { error } = await supabase
        .from('attendance')
        .upsert(upserts, { onConflict: 'user_id,course,date,student_name' })
      if (error) throw error

      setSaved(true)
      showToast('success', `Asistencia guardada - ${course} - ${date}`)
    } catch (error) {
      console.error(error)
      showToast('error', 'Error al guardar asistencia')
    } finally {
      setSaving(false)
    }
  }


  const exportPDF = async () => {
    setExporting(true)
    try {
      const doc = new jsPDF()

      doc.setFillColor(37, 99, 235)
      doc.rect(0, 0, 210, 28, 'F')
      doc.setTextColor(255, 255, 255)
      doc.setFontSize(16)
      doc.setFont('helvetica', 'bold')
      doc.text('EduNova - Reporte de Asistencia', 14, 12)
      doc.setFontSize(9)
      doc.setFont('helvetica', 'normal')
      doc.text(`${course}  |  Fecha: ${date}`, 14, 21)
      doc.text(`Generado: ${new Date().toLocaleDateString('es')}`, 150, 21)
      doc.setTextColor(0, 0, 0)

      doc.setFontSize(10)
      doc.setFont('helvetica', 'bold')
      doc.text('Resumen', 14, 36)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      doc.setTextColor(16, 185, 129); doc.text(`Presentes: ${present}`, 14, 43)
      doc.setTextColor(239, 68, 68); doc.text(`Ausentes: ${absent}`, 60, 43)
      doc.setTextColor(245, 158, 11); doc.text(`Tardanzas: ${late}`, 106, 43)
      doc.setTextColor(37, 99, 235); doc.text(`Asistencia: ${pct}%`, 152, 43)
      doc.setTextColor(0, 0, 0)

      autoTable(doc, {
        startY: 50,
        head: [['#', 'Estudiante', 'Estado', 'Justificado', 'Observación']],
        body: att.map((a, i) => [
          i + 1,
          a.n,
          STATUS_LABEL[a.s],
          a.j ? 'Sí' : 'No',
          a.o || '-',
        ]),
        styles: { fontSize: 9, cellPadding: 3 },
        headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        columnStyles: { 0: { cellWidth: 10 }, 1: { cellWidth: 55 }, 2: { cellWidth: 22 }, 3: { cellWidth: 22 } },
        didParseCell: (data) => {
          if (data.section === 'body' && data.column.index === 2) {
            const v = data.cell.raw
            data.cell.styles.textColor =
              v === 'Presente' ? [16, 185, 129] : v === 'Ausente' ? [239, 68, 68] : [245, 158, 11]
            data.cell.styles.fontStyle = 'bold'
          }
        },
      })

      const fileName = `Asistencia_${course.replace(/ /g, '_')}_${date}.pdf`

      // Use an explicit Blob download for better compatibility than `doc.save(...)`.
      const blob = doc.output('blob')
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      showToast('success', 'PDF de asistencia descargado')
    } catch (error) {
      console.error(error)
      showToast('error', 'Error al generar PDF')
    } finally {
      setExporting(false)
    }
  }


  const exportExcel = async () => {
    setExporting(true)
    try {
      // Excel con estilos (xlsx-js-style) para que se vea profesional en Excel/WPS.
      const now = new Date()
      const title = `Reporte de Asistencia - ${course}`
      const subtitle = `Fecha: ${date}  |  Generado: ${now.toLocaleDateString('es')}`

      const borderThin = {
        top: { style: 'thin', color: { rgb: 'E5E7EB' } },
        bottom: { style: 'thin', color: { rgb: 'E5E7EB' } },
        left: { style: 'thin', color: { rgb: 'E5E7EB' } },
        right: { style: 'thin', color: { rgb: 'E5E7EB' } },
      }

      const styles = {
        title: {
          font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 14 },
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
        cellCenter: {
          font: { color: { rgb: '111827' }, sz: 10 },
          alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
          border: borderThin,
        },
        zebra: {
          fill: { patternType: 'solid', fgColor: { rgb: 'FAFAFA' } },
        },
        summaryTitle: {
          font: { bold: true, color: { rgb: '111827' }, sz: 11 },
          alignment: { horizontal: 'left', vertical: 'center' },
        },
        summaryKey: {
          font: { bold: true, color: { rgb: '374151' }, sz: 10 },
          alignment: { horizontal: 'left', vertical: 'center' },
        },
        summaryValue: {
          font: { bold: true, color: { rgb: '111827' }, sz: 10 },
          alignment: { horizontal: 'right', vertical: 'center' },
        },
      }

      const wb = XLSX.utils.book_new()
      const wsData = []

      wsData.push([
        { v: title, t: 's', s: styles.title },
        { v: '', t: 's', s: styles.title },
        { v: '', t: 's', s: styles.title },
        { v: '', t: 's', s: styles.title },
        { v: '', t: 's', s: styles.title },
      ])
      wsData.push([
        { v: subtitle, t: 's', s: styles.subtitle },
        { v: '', t: 's', s: styles.subtitle },
        { v: '', t: 's', s: styles.subtitle },
        { v: '', t: 's', s: styles.subtitle },
        { v: '', t: 's', s: styles.subtitle },
      ])
      wsData.push(['', '', '', '', ''])

      wsData.push([
        { v: '#', t: 's', s: styles.header },
        { v: 'Estudiante', t: 's', s: styles.header },
        { v: 'Estado', t: 's', s: styles.header },
        { v: 'Justificado', t: 's', s: styles.header },
        { v: 'Observacion', t: 's', s: styles.header },
      ])

      att.forEach((a, index) => {
        const baseStyle = { ...styles.cell, ...(index % 2 === 1 ? styles.zebra : {}) }
        const centerStyle = { ...styles.cellCenter, ...(index % 2 === 1 ? styles.zebra : {}) }
        wsData.push([
          { v: index + 1, t: 'n', s: centerStyle },
          { v: a.n, t: 's', s: baseStyle },
          { v: STATUS_LABEL[a.s], t: 's', s: centerStyle },
          { v: a.j ? 'Si' : 'No', t: 's', s: centerStyle },
          { v: a.o || '', t: 's', s: baseStyle },
        ])
      })

      wsData.push(['', '', '', '', ''])
      wsData.push([{ v: 'RESUMEN', t: 's', s: styles.summaryTitle }, '', '', '', ''])

      const summaryRows = [
        ['Presentes', present],
        ['Ausentes', absent],
        ['Tardanzas', late],
        ['% Asistencia', `${pct}%`],
      ]
      summaryRows.forEach(([k, v]) => {
        wsData.push([
          { v: k, t: 's', s: styles.summaryKey },
          { v, t: typeof v === 'number' ? 'n' : 's', s: styles.summaryValue },
          '', '', '',
        ])
      })

      const ws = XLSX.utils.aoa_to_sheet(wsData)
      ws['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 4 } },
        { s: { r: 1, c: 0 }, e: { r: 1, c: 4 } },
      ]
      ws['!cols'] = [
        { wch: 5 },
        { wch: 34 },
        { wch: 14 },
        { wch: 14 },
        { wch: 42 },
      ]
      ws['!rows'] = [{ hpt: 26 }, { hpt: 18 }]

      XLSX.utils.book_append_sheet(wb, ws, 'Asistencia')
      XLSX.writeFile(wb, `Asistencia_${course.replace(/ /g, '_')}_${date}.xlsx`)
      showToast('success', 'Excel de asistencia descargado')
      return
      /*
      const wsData = [
        [`Reporte de Asistencia - ${course}`],
        [`Fecha: ${date}  |  Generado: ${new Date().toLocaleDateString('es')}`],
        [],
        ['#', 'Estudiante', 'Estado', 'Justificado', 'Observación'],
        ...att.map((a, i) => [i + 1, a.n, STATUS_LABEL[a.s], a.j ? 'Sí' : 'No', a.o || '']),
        [],
        ['RESUMEN'],
        ['Presentes', present],
        ['Ausentes', absent],
        ['Tardanzas', late],
        ['% Asistencia', `${pct}%`],
      ]
      const ws = XLSX.utils.aoa_to_sheet(wsData)
      ws['!cols'] = [{ wch: 5 }, { wch: 30 }, { wch: 12 }, { wch: 12 }, { wch: 30 }]
      XLSX.utils.book_append_sheet(wb, ws, 'Asistencia')
      XLSX.writeFile(wb, `Asistencia_${course.replace(/ /g, '_')}_${date}.xlsx`)
      showToast('success', 'Excel de asistencia descargado')
      */
    } catch (error) {
      console.error(error)
      showToast('error', 'Error al generar Excel')
    } finally {
      setExporting(false)
    }
  }

  const present = att.filter(a => a.s === 'present').length
  const absent = att.filter(a => a.s === 'absent').length
  const late = att.filter(a => a.s === 'late').length
  const pct = att.length > 0 ? Math.round((present / att.length) * 100) : 0

  return (
    <section>
      <div className="page-header">
        <div className="breadcrumb">
          <a onClick={() => onNavigate('dashboard')}>Inicio</a><span>/</span><span>Asistencia</span>
        </div>
        <h2>Control de Asistencia</h2>
        <p>Registra la asistencia diaria. Exporta reportes en PDF o Excel.</p>
      </div>

      <div className="stats-grid">
        {[
          { i: 'fa-check-circle', c: 'green', v: present, l: 'Presentes' },
          { i: 'fa-times-circle', c: 'orange', v: absent, l: 'Ausentes' },
          { i: 'fa-clock', c: 'purple', v: late, l: 'Tardanzas' },
          { i: 'fa-percentage', c: 'blue', v: `${pct}%`, l: 'Asistencia' },
        ].map(s => (
          <div className="stat-card" key={s.l}>
            <div className={`icon ${s.c}`}><i className={`fas ${s.i}`} /></div>
            <div className="value">{s.v}</div>
            <div className="label">{s.l}</div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-header">
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <select className="form-control" style={{ width: 'auto' }} value={subject} onChange={e => setSubject(e.target.value)}>
              {ACADEMIC_SUBJECT_OPTIONS.map(option => <option key={option}>{option}</option>)}
            </select>
            <select className="form-control" style={{ width: 'auto' }} value={section} onChange={e => setSection(e.target.value)} disabled={courseOptions.length === 0}>
              {courseOptions.length === 0 ? (
                <option value="">No hay cursos</option>
              ) : (
                courseOptions.map(option => <option key={option}>{option}</option>)
              )}
            </select>
            <input type="date" className="form-control" style={{ width: 'auto' }} value={date} onChange={e => setDate(e.target.value)} />
            {!loading && att.length > 0 && (
              <span
                style={{
                  fontSize: '0.82rem',
                  color: pct >= 80 ? 'var(--success)' : pct >= 60 ? 'var(--warning)' : 'var(--danger)',
                  fontWeight: 600,
                  padding: '0.3rem 0.75rem',
                  background: pct >= 80 ? 'rgba(16,185,129,0.1)' : pct >= 60 ? 'rgba(245,158,11,0.1)' : 'rgba(239,68,68,0.1)',
                  borderRadius: 8,
                }}
              >
                {pct >= 80 ? 'Buena asistencia' : pct >= 60 ? 'Asistencia regular' : 'Asistencia baja'}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button className="btn btn-sm btn-secondary" onClick={markAll}>
              <i className="fas fa-check-double" />Todos presentes
            </button>
            <button className="btn btn-sm btn-secondary" onClick={markAllAbsent}>
              <i className="fas fa-times" />Todos ausentes
            </button>
            <button className="btn btn-sm btn-secondary" onClick={exportPDF} disabled={exporting || att.length === 0} title="Exportar PDF">
              <i className="fas fa-file-pdf" style={{ color: 'var(--danger)' }} />PDF
            </button>
            <button className="btn btn-sm btn-secondary" onClick={exportExcel} disabled={exporting || att.length === 0} title="Exportar Excel">
              <i className="fas fa-file-excel" style={{ color: 'var(--success)' }} />Excel
            </button>
            <button className="btn btn-success" onClick={handleSave} disabled={saving}>
              {saving
                ? <><i className="fas fa-spinner fa-spin" />Guardando...</>
                : saved
                  ? <><i className="fas fa-check" />Guardado</>
                  : <><i className="fas fa-save" />Guardar</>}
            </button>
          </div>
        </div>

        <div className="card-body" style={{ overflowX: 'auto' }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: '#6b7280' }}>
              <i className="fas fa-spinner fa-spin" style={{ fontSize: '1.5rem', display: 'block', marginBottom: '0.5rem' }} />
              Cargando asistencia...
            </div>
          ) : att.length === 0 ? (
            <div className="empty-state">
              <i className="fas fa-users" />
              <h3>No hay estudiantes</h3>
              <p>No hay estudiantes reales registrados en esta sección.</p>
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Estudiante</th>
                  <th style={{ textAlign: 'center' }}>Presente</th>
                  <th style={{ textAlign: 'center' }}>Ausente</th>
                  <th style={{ textAlign: 'center' }}>Tardanza</th>
                  <th style={{ textAlign: 'center' }}>Justificado</th>
                  <th>Observación</th>
                  <th style={{ textAlign: 'center' }}>Estado</th>
                </tr>
              </thead>
              <tbody>
                {att.map((a, i) => (
                  <tr
                    key={i}
                    style={{
                      background: a.s === 'absent' ? 'rgba(239,68,68,0.04)' : a.s === 'late' ? 'rgba(245,158,11,0.04)' : '',
                    }}
                  >
                    <td style={{ color: '#9ca3af', fontSize: '0.85rem' }}>{i + 1}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div
                          style={{
                            width: 30,
                            height: 30,
                            borderRadius: 8,
                            flexShrink: 0,
                            background: 'linear-gradient(135deg,#2563eb,#7c3aed)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: '#fff',
                            fontWeight: 600,
                            fontSize: '0.7rem',
                          }}
                        >
                          {a.n.split(' ').map(w => w[0]).slice(0, 2).join('')}
                        </div>
                        <strong style={{ fontSize: '0.875rem' }}>{a.n}</strong>
                      </div>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <input type="radio" name={`att${i}`} checked={a.s === 'present'} onChange={() => setS(i, 'present')} />
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <input type="radio" name={`att${i}`} checked={a.s === 'absent'} onChange={() => setS(i, 'absent')} />
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <input type="radio" name={`att${i}`} checked={a.s === 'late'} onChange={() => setS(i, 'late')} />
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={a.j}
                        onChange={() => togJ(i)}
                        disabled={a.s === 'present'}
                        title={a.s === 'present' ? 'Solo aplica a ausentes/tardanzas' : ''}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        className="form-control"
                        value={a.o}
                        placeholder="Observación..."
                        onChange={e => setO(i, e.target.value)}
                        style={{ fontSize: '0.82rem' }}
                      />
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <span style={{ color: STATUS_COLOR[a.s], fontSize: '0.78rem', fontWeight: 600 }}>
                        <i className={`fas ${STATUS_ICON[a.s]}`} style={{ marginRight: 4 }} />
                        {STATUS_LABEL[a.s]}
                        {a.j && a.s !== 'present' && (
                          <span style={{ marginLeft: 4, fontSize: '0.7rem', color: 'var(--primary)' }}>(J)</span>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: '#f3f4f6', fontWeight: 600, fontSize: '0.82rem' }}>
                  <td colSpan={2} style={{ color: '#6b7280' }}>Resumen del día</td>
                  <td style={{ textAlign: 'center', color: 'var(--success)' }}>{present}</td>
                  <td style={{ textAlign: 'center', color: 'var(--danger)' }}>{absent}</td>
                  <td style={{ textAlign: 'center', color: 'var(--warning)' }}>{late}</td>
                  <td style={{ textAlign: 'center', color: 'var(--primary)' }}>{att.filter(a => a.j).length}</td>
                  <td colSpan={2} style={{ textAlign: 'right', color: 'var(--primary)' }}>{pct}% de asistencia</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </section>
  )
}
