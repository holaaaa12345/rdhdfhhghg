import { useEffect, useMemo, useState } from 'react'
import Modal from '../components/Modal.jsx'
import { supabase } from '../services/supabaseClient.js'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import * as XLSX from 'xlsx-js-style'
import {
  ACADEMIC_SUBJECT_OPTIONS,
  buildAcademicCourse,
} from '../data/projectOptions.js'
import { studentsService } from '../services/academicServices.js'
import { DEFAULT_GRADING_SCALES, DEFAULT_PERIODS, fetchSystemSettings } from '../services/settingsService.js'

const PERIODS = ['Periodo 1', 'Periodo 2', 'Periodo 3', 'Periodo 4', 'Todos']
const TIPOS = ['Notas por Curso', 'Boletin Individual', 'Analisis de Rendimiento', 'Reporte de Asistencia']

const buildStatusMeta = (value) => {
  if (value >= 70) return { label: 'Aprobado', cls: 'active', color: 'var(--success)' }
  if (value >= 60) return { label: 'En riesgo', cls: 'pending', color: 'var(--warning)' }
  return { label: 'Reprobado', cls: 'danger', color: 'var(--danger)' }
}

const buildAttendanceMeta = (value) => {
  if (value >= 85) return { label: 'Excelente', cls: 'active', color: 'var(--success)' }
  if (value >= 70) return { label: 'Regular', cls: 'pending', color: 'var(--warning)' }
  return { label: 'Baja', cls: 'danger', color: 'var(--danger)' }
}

const getCourseCode = (courseName) => {
  const parts = String(courseName || '').split(' - ')
  return parts[1] || parts[0] || ''
}

const getDefaultScale = (settings) => {
  const available = settings?.grading_scales?.length ? settings.grading_scales : DEFAULT_GRADING_SCALES
  return available.find(scale => scale.is_default) || available[0]
}

const buildScaleHelpers = (scale) => {
  const scaleId = scale?.id || 'scale_100'

  const formatAverage = (rawValue) => {
    const numeric = Number(rawValue) || 0
    if (scaleId === 'scale_5') return (numeric / 20).toFixed(1)
    if (scaleId === 'scale_10') return (numeric / 10).toFixed(1)
    if (scaleId === 'scale_letters') {
      if (numeric >= 90) return 'A'
      if (numeric >= 80) return 'B'
      if (numeric >= 70) return 'C'
      if (numeric >= 60) return 'D'
      return 'F'
    }
    return numeric.toFixed(1)
  }

  const label = scaleId === 'scale_5'
    ? 'Escala 1-5'
    : scaleId === 'scale_10'
      ? 'Escala 0-10'
      : scaleId === 'scale_letters'
        ? 'Escala A-F'
        : 'Escala 0-100'

  return { formatAverage, label }
}

const getPeriodRange = (periodName, settings) => {
  if (!periodName || periodName === 'Todos') return null
  const periods = settings?.academic_periods?.length ? settings.academic_periods : DEFAULT_PERIODS
  return periods.find(period => period.name === periodName) || null
}

const createActivityDefs = (activities, periodo) => {
  const ordered = [...(activities || [])].sort((a, b) => {
    if (a.period === b.period) return String(a.name).localeCompare(String(b.name), 'es')
    return String(a.period).localeCompare(String(b.period), 'es')
  })

  return ordered.map((activity, index) => ({
    id: activity.id || `${activity.period || periodo}-${activity.name}-${index}`,
    period: activity.period || periodo,
    name: activity.name,
    weight: Number(activity.weight) || 0,
    label: periodo === 'Todos'
      ? `${activity.period || 'Periodo'} - ${activity.name}`
      : activity.name,
  }))
}

const averageWithWeights = (rows) => {
  const totalWeight = rows.reduce((sum, row) => sum + (Number(row.weight) || 0), 0)
  if (totalWeight === 0) return 0

  return rows.reduce((sum, row) => {
    const grade = Number(row.grade) || 0
    const weight = Number(row.weight) || 0
    return sum + (grade * weight / totalWeight)
  }, 0)
}

export function Reports({ showToast, onNavigate }) {
  const [tipo, setTipo] = useState('Notas por Curso')
  const [subject, setSubject] = useState(ACADEMIC_SUBJECT_OPTIONS[0] || '')
  const [courseOptions, setCourseOptions] = useState([])
  const [section, setSection] = useState('')
  const [periodo, setPeriodo] = useState('Periodo 1')
  const [formato, setFormato] = useState('PDF')
  const [previewM, setPreviewM] = useState(false)
  const [historial, setHistorial] = useState([])
  const [loadingH, setLoadingH] = useState(true)
  const [loadingD, setLoadingD] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [settings, setSettings] = useState(null)
  const [reportState, setReportState] = useState({
    mode: 'grades',
    rows: [],
    activityDefs: [],
    summary: {},
  })
  const curso = buildAcademicCourse(subject, section)
  const courseCode = getCourseCode(curso)
  const scale = getDefaultScale(settings)
  const scaleHelpers = buildScaleHelpers(scale)

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
    fetchSettings()
    fetchHistorial()
  }, [])

  useEffect(() => {
    fetchReportData()
  }, [tipo, curso, periodo, settings])

  const fetchSettings = async () => {
    try {
      setSettings(await fetchSystemSettings())
    } catch (error) {
      console.error(error)
      setSettings({ grading_scales: DEFAULT_GRADING_SCALES, academic_periods: DEFAULT_PERIODS })
    }
  }

  const fetchHistorial = async () => {
    setLoadingH(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const { data, error } = await supabase
        .from('reports')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(20)
      if (error) throw error

      setHistorial((data || []).map(row => ({
        id: row.id,
        tipo: row.type,
        curso: row.course,
        periodo: row.period,
        formato: row.format,
        fecha: new Date(row.created_at).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' }),
      })))
    } catch (error) {
      console.error(error)
    } finally {
      setLoadingH(false)
    }
  }

  const fetchReportData = async () => {
    setLoadingD(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('Usuario no autenticado')

      const { data: studentsData, error: studentsError } = await supabase
        .from('students')
        .select('id, name, course')
        .eq('course', courseCode)
        .order('name', { ascending: true })
      if (studentsError) throw studentsError

      if (tipo === 'Reporte de Asistencia') {
        const attendanceQuery = supabase
          .from('attendance')
          .select('student_name, status, date')
          .eq('user_id', user.id)
          .eq('course', curso)

        const selectedRange = getPeriodRange(periodo, settings)
        if (selectedRange?.start_date) attendanceQuery.gte('date', selectedRange.start_date)
        if (selectedRange?.end_date) attendanceQuery.lte('date', selectedRange.end_date)

        const { data: attendanceRows, error: attendanceError } = await attendanceQuery
        if (attendanceError) throw attendanceError

        const rows = (studentsData || []).map(student => {
          const records = (attendanceRows || []).filter(item => item.student_name === student.name)
          const present = records.filter(item => item.status === 'present').length
          const absent = records.filter(item => item.status === 'absent').length
          const late = records.filter(item => item.status === 'late').length
          const total = records.length
          const percentage = total ? (present / total) * 100 : 0
          const meta = buildAttendanceMeta(percentage)

          return {
            id: student.id,
            name: student.name,
            present,
            absent,
            late,
            total,
            percentage,
            percentageLabel: `${percentage.toFixed(1)}%`,
            status: meta.label,
            statusCls: meta.cls,
          }
        })

        setReportState({
          mode: 'attendance',
          rows,
          activityDefs: [],
          summary: {
            totalStudents: rows.length,
            averageAttendance: rows.length ? rows.reduce((sum, row) => sum + row.percentage, 0) / rows.length : 0,
            lowAttendance: rows.filter(row => row.percentage < 70).length,
          },
        })
        return
      }

      const activitiesQuery = supabase
        .from('activities')
        .select('id, name, weight, period')
        .eq('user_id', user.id)
        .eq('course', curso)
        .order('created_at', { ascending: true })
      if (periodo !== 'Todos') activitiesQuery.eq('period', periodo)

      const gradesQuery = supabase
        .from('grades')
        .select('student_name, activity, grade, weight, period, comment')
        .eq('user_id', user.id)
        .eq('course', curso)
      if (periodo !== 'Todos') gradesQuery.eq('period', periodo)

      const [{ data: activitiesData, error: activitiesError }, { data: gradesData, error: gradesError }] = await Promise.all([
        activitiesQuery,
        gradesQuery,
      ])
      if (activitiesError) throw activitiesError
      if (gradesError) throw gradesError

      const activityDefs = createActivityDefs(activitiesData || [], periodo)
      const rows = (studentsData || []).map(student => {
        const gradesByStudent = (gradesData || []).filter(item => item.student_name === student.name)
        const gradeMap = {}

        activityDefs.forEach(def => {
          const match = gradesByStudent.find(item => item.activity === def.name && (periodo === 'Todos' ? item.period === def.period : true))
          gradeMap[def.label] = match ? Number(match.grade) : 0
        })

        const averageSource = activityDefs.map(def => {
          const match = gradesByStudent.find(item => item.activity === def.name && (periodo === 'Todos' ? item.period === def.period : true))
          return { grade: match ? Number(match.grade) : 0, weight: def.weight || Number(match?.weight) || 0 }
        })

        const rawAverage = averageWithWeights(averageSource)
        const statusMeta = buildStatusMeta(rawAverage)
        const commentEntry = gradesByStudent.find(item => item.comment)

        return {
          id: student.id,
          name: student.name,
          grades: gradeMap,
          rawAvg: rawAverage,
          avg: scaleHelpers.formatAverage(rawAverage),
          status: statusMeta.label,
          statusCls: statusMeta.cls,
          comment: commentEntry?.comment || '',
        }
      })

      setReportState({
        mode: 'grades',
        rows,
        activityDefs,
        summary: {
          totalStudents: rows.length,
          average: rows.length ? rows.reduce((sum, row) => sum + row.rawAvg, 0) / rows.length : 0,
          approved: rows.filter(row => row.rawAvg >= 70).length,
          warning: rows.filter(row => row.rawAvg >= 60 && row.rawAvg < 70).length,
          failed: rows.filter(row => row.rawAvg < 60).length,
        },
      })
    } catch (error) {
      console.error(error)
      showToast('error', 'Error al cargar datos del reporte')
      setReportState({ mode: 'grades', rows: [], activityDefs: [], summary: {} })
    } finally {
      setLoadingD(false)
    }
  }

  const saveToHistorial = async (fmt) => {
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const { data, error } = await supabase
        .from('reports')
        .insert([{ user_id: user.id, type: tipo, course: curso, period: periodo, format: fmt }])
        .select()
        .single()
      if (error) throw error

      setHistorial(prev => [{
        id: data.id,
        tipo,
        curso,
        periodo,
        formato: fmt,
        fecha: new Date().toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' }),
      }, ...prev])
    } catch (error) {
      console.error(error)
    }
  }

  const exportPDF = async () => {
    setGenerating(true)
    try {
      const doc = new jsPDF()
      doc.setFillColor(37, 99, 235)
      doc.rect(0, 0, 210, 30, 'F')
      doc.setTextColor(255, 255, 255)
      doc.setFontSize(18)
      doc.setFont('helvetica', 'bold')
      doc.text('EduNova - Sistema Academico', 14, 13)
      doc.setFontSize(10)
      doc.setFont('helvetica', 'normal')
      doc.text(`${tipo} | ${curso} | ${periodo}`, 14, 22)
      doc.text(`Escala: ${scaleHelpers.label}`, 140, 22)
      doc.setTextColor(0, 0, 0)

      if (reportState.mode === 'attendance') {
        autoTable(doc, {
          startY: 38,
          head: [['Estudiante', 'Presentes', 'Ausentes', 'Tardanzas', '% Asistencia', 'Estado']],
          body: reportState.rows.map(row => [row.name, row.present, row.absent, row.late, row.percentageLabel, row.status]),
          styles: { fontSize: 9, cellPadding: 3 },
          headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: 'bold' },
          alternateRowStyles: { fillColor: [248, 250, 252] },
        })
      } else if (tipo === 'Boletin Individual') {
        reportState.rows.forEach((student, index) => {
          if (index > 0) doc.addPage()
          doc.setFontSize(13)
          doc.setFont('helvetica', 'bold')
          doc.setTextColor(0, 0, 0)
          doc.text('Boletin de Calificaciones', 14, 42)
          doc.setFontSize(11)
          doc.text(`Estudiante: ${student.name}`, 14, 52)
          doc.setFont('helvetica', 'normal')
          doc.setFontSize(10)
          doc.text(`Curso: ${curso} | ${periodo}`, 14, 60)
          doc.text(`Promedio final: ${student.avg} (${scaleHelpers.label})`, 14, 67)
          autoTable(doc, {
            startY: 74,
            head: [['Actividad', 'Nota']],
            body: reportState.activityDefs.map(def => [def.label, student.grades[def.label] ?? 0]),
            styles: { fontSize: 10 },
            headStyles: { fillColor: [37, 99, 235], textColor: 255 },
          })
        })
      } else {
        const cols = ['Estudiante', ...reportState.activityDefs.map(def => def.label), `Promedio (${scaleHelpers.label})`, 'Estado']
        autoTable(doc, {
          startY: 38,
          head: [cols],
          body: reportState.rows.map(row => [row.name, ...reportState.activityDefs.map(def => row.grades[def.label] ?? 0), row.avg, row.status]),
          styles: { fontSize: 9, cellPadding: 3 },
          headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: 'bold' },
          alternateRowStyles: { fillColor: [248, 250, 252] },
        })
      }

      const fileName = `${tipo.replace(/ /g, '_')}_${curso.replace(/ /g, '_')}_${periodo}.pdf`

      // Use explicit Blob download for better compatibility than `doc.save(...)`.
      const blob = doc.output('blob')
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      await saveToHistorial('PDF')
      showToast('success', 'PDF generado y descargado correctamente')
    } catch (error) {
      console.error(error)
      showToast('error', 'Error al generar el PDF')
    } finally {
      setGenerating(false)
    }
  }

  const exportExcel = async () => {
    setGenerating(true)
    try {
      const wb = XLSX.utils.book_new()
      const now = new Date()

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
        cellCenter: {
          font: { color: { rgb: '111827' }, sz: 10 },
          alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
          border: borderThin,
        },
        zebra: {
          fill: { patternType: 'solid', fgColor: { rgb: 'FAFAFA' } },
        },
      }

      const buildSheet = ({ sheetTitle, sheetSubtitle, headers, rows, colWidths }) => {
        const colCount = headers.length
        const wsData = []

        wsData.push(Array.from({ length: colCount }).map((_, i) => ({
          v: i === 0 ? sheetTitle : '',
          t: 's',
          s: styles.title,
        })))

        wsData.push(Array.from({ length: colCount }).map((_, i) => ({
          v: i === 0 ? sheetSubtitle : '',
          t: 's',
          s: styles.subtitle,
        })))

        wsData.push(Array.from({ length: colCount }).map(() => ''))

        wsData.push(headers.map(h => ({ v: h, t: 's', s: styles.header })))

        rows.forEach((row, idx) => {
          const isZebra = idx % 2 === 1
          wsData.push(row.map((value, colIdx) => {
            const base = colIdx === 0 ? styles.cell : styles.cellCenter
            return {
              v: value ?? '',
              t: typeof value === 'number' ? 'n' : 's',
              s: { ...base, ...(isZebra ? styles.zebra : {}) },
            }
          }))
        })

        const ws = XLSX.utils.aoa_to_sheet(wsData)
        ws['!merges'] = [
          { s: { r: 0, c: 0 }, e: { r: 0, c: colCount - 1 } },
          { s: { r: 1, c: 0 }, e: { r: 1, c: colCount - 1 } },
        ]
        ws['!cols'] = colWidths.map(wch => ({ wch }))
        ws['!rows'] = [{ hpt: 24 }, { hpt: 18 }]
        return ws
      }

      if (reportState.mode === 'attendance') {
        const headers = ['Estudiante', 'Presentes', 'Ausentes', 'Tardanzas', '% Asistencia', 'Estado']
        const rows = reportState.rows.map(row => ([
          row.name,
          Number(row.present) || 0,
          Number(row.absent) || 0,
          Number(row.late) || 0,
          row.percentageLabel,
          row.status,
        ]))

        const ws = buildSheet({
          sheetTitle: `${tipo} - ${curso}`,
          sheetSubtitle: `Periodo: ${periodo}  |  Generado: ${now.toLocaleDateString('es')}`,
          headers,
          rows,
          colWidths: [34, 12, 12, 12, 16, 14],
        })
        XLSX.utils.book_append_sheet(wb, ws, 'Asistencia')
      } else {
        const headers = ['Estudiante', ...reportState.activityDefs.map(def => def.label), `Promedio (${scaleHelpers.label})`, 'Estado']
        const rows = reportState.rows.map(row => ([
          row.name,
          ...reportState.activityDefs.map(def => Number(row.grades[def.label] ?? 0)),
          Number(row.avg ?? 0),
          row.status,
        ]))

        const colWidths = [
          34,
          ...reportState.activityDefs.map(() => 14),
          18,
          14,
        ]

        const ws = buildSheet({
          sheetTitle: `${tipo} - ${curso}`,
          sheetSubtitle: `Periodo: ${periodo}  |  Escala: ${scaleHelpers.label}  |  Generado: ${now.toLocaleDateString('es')}`,
          headers,
          rows,
          colWidths,
        })
        XLSX.utils.book_append_sheet(wb, ws, 'Calificaciones')
      }

      XLSX.writeFile(wb, `${tipo.replace(/ /g, '_')}_${curso.replace(/ /g, '_')}_${periodo}.xlsx`)
      await saveToHistorial('Excel')
      showToast('success', 'Excel generado y descargado correctamente')
    } catch (error) {
      console.error(error)
      showToast('error', 'Error al generar el Excel')
    } finally {
      setGenerating(false)
    }
  }

  const handleGenerate = async () => {
    if (reportState.rows.length === 0) {
      showToast('warning', 'No hay datos para generar el reporte')
      return
    }
    if (formato === 'PDF') return exportPDF()
    if (formato === 'Excel (.xlsx)') return exportExcel()
    window.print()
    await saveToHistorial('Impresion')
  }

  const deleteFromHistorial = async (id) => {
    try {
      const { error } = await supabase.from('reports').delete().eq('id', id)
      if (error) throw error
      setHistorial(prev => prev.filter(item => item.id !== id))
      showToast('success', 'Reporte eliminado del historial')
    } catch (error) {
      console.error(error)
      showToast('error', 'Error al eliminar')
    }
  }

  const quickStats = useMemo(() => {
    if (reportState.mode === 'attendance') {
      return [
        { i: 'fa-percentage', c: 'blue', v: `${(reportState.summary.averageAttendance || 0).toFixed(1)}%`, l: 'Asistencia general' },
        { i: 'fa-users', c: 'green', v: reportState.summary.totalStudents || 0, l: 'Estudiantes' },
        { i: 'fa-triangle-exclamation', c: 'orange', v: reportState.summary.lowAttendance || 0, l: 'Baja asistencia' },
      ]
    }
    return [
      { i: 'fa-chart-line', c: 'blue', v: scaleHelpers.formatAverage(reportState.summary.average || 0), l: `Promedio (${scaleHelpers.label})` },
      { i: 'fa-check-circle', c: 'green', v: reportState.summary.approved || 0, l: 'Aprobados' },
      { i: 'fa-exclamation', c: 'orange', v: reportState.summary.warning || 0, l: 'En riesgo' },
      { i: 'fa-times-circle', c: 'purple', v: reportState.summary.failed || 0, l: 'Reprobados' },
    ]
  }, [reportState, scaleHelpers])

  return (
    <section>
      <div className="page-header">
        <div className="breadcrumb"><a onClick={() => onNavigate('dashboard')}>Inicio</a><span>/</span><span>Reportes</span></div>
        <h2>Reportes y Boletines</h2>
        <p>Genera reportes de notas, boletines y asistencia con estudiantes reales del sistema.</p>
      </div>

      <div className="stats-grid">
        {quickStats.map(item => (
          <div className="stat-card" key={item.l}>
            <div className={`icon ${item.c}`}><i className={`fas ${item.i}`} /></div>
            <div className="value">{item.v}</div>
            <div className="label">{item.l}</div>
          </div>
        ))}
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-header"><h3>Generar Reporte</h3></div>
          <div className="card-body">
            <div className="form-group"><label>Tipo de Reporte</label><select className="form-control" value={tipo} onChange={e => setTipo(e.target.value)}>{TIPOS.map(item => <option key={item}>{item}</option>)}</select></div>
            <div className="form-group"><label>Materia</label><select className="form-control" value={subject} onChange={e => setSubject(e.target.value)}>{ACADEMIC_SUBJECT_OPTIONS.map(option => <option key={option}>{option}</option>)}</select></div>
            <div className="form-group">
              <label>Curso</label>
              <select className="form-control" value={section} onChange={e => setSection(e.target.value)} disabled={courseOptions.length === 0}>
                {courseOptions.length === 0 ? (
                  <option value="">No hay cursos</option>
                ) : (
                  courseOptions.map(option => <option key={option}>{option}</option>)
                )}
              </select>
            </div>
            <div className="form-group"><label>Periodo</label><select className="form-control" value={periodo} onChange={e => setPeriodo(e.target.value)}>{PERIODS.map(item => <option key={item}>{item}</option>)}</select></div>
            <div className="form-group">
              <label>Formato</label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {['PDF', 'Excel (.xlsx)', 'Imprimir'].map(option => (
                  <div key={option} onClick={() => setFormato(option)} style={{ flex: 1, padding: '0.6rem', borderRadius: 8, textAlign: 'center', cursor: 'pointer', fontSize: '0.85rem', fontWeight: formato === option ? 600 : 400, background: formato === option ? 'var(--primary)' : '#f3f4f6', color: formato === option ? '#fff' : '#374151' }}>
                    <i className={`fas ${option === 'PDF' ? 'fa-file-pdf' : option === 'Imprimir' ? 'fa-print' : 'fa-file-excel'}`} style={{ marginRight: 5 }} />{option}
                  </div>
                ))}
              </div>
            </div>

            {loadingD ? (
              <div style={{ textAlign: 'center', padding: '1rem', color: '#6b7280', fontSize: '0.85rem' }}><i className="fas fa-spinner fa-spin" style={{ marginRight: 6 }} />Cargando datos...</div>
            ) : (
              <div style={{ background: '#f3f4f6', borderRadius: 8, padding: '0.75rem', marginBottom: '1rem', fontSize: '0.82rem' }}>
                <p style={{ fontWeight: 600, marginBottom: '0.4rem', color: '#374151' }}><i className="fas fa-users" style={{ marginRight: 5, color: 'var(--primary)' }} />{reportState.summary.totalStudents || reportState.rows.length} estudiantes en {curso}</p>
                <p style={{ color: '#6b7280' }}>{reportState.mode === 'attendance' ? 'Reporte basado en asistencias reales del sistema.' : `${reportState.activityDefs.length} actividades y ${scaleHelpers.label} aplicada al promedio final.`}</p>
              </div>
            )}

            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="btn btn-primary" onClick={handleGenerate} disabled={generating || loadingD}>{generating ? <><i className="fas fa-spinner fa-spin" />Generando...</> : <><i className="fas fa-file-export" />Generar</>}</button>
              <button className="btn btn-secondary" onClick={() => setPreviewM(true)} disabled={loadingD}><i className="fas fa-eye" />Vista Previa</button>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><h3>Reportes Generados</h3></div>
          <div className="card-body">
            {loadingH ? (
              <div style={{ textAlign: 'center', padding: '1.5rem', color: '#6b7280' }}><i className="fas fa-spinner fa-spin" style={{ display: 'block', fontSize: '1.5rem', marginBottom: '0.5rem' }} />Cargando historial...</div>
            ) : historial.length === 0 ? (
              <div className="empty-state" style={{ padding: '1.5rem' }}><i className="fas fa-file-alt" /><h3>Sin reportes</h3><p>Genera tu primer reporte.</p></div>
            ) : historial.map(item => (
              <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem', borderBottom: '1px solid #e5e7eb' }}>
                <div><p style={{ fontWeight: 600, fontSize: '0.875rem' }}>{item.tipo}</p><p style={{ fontSize: '0.78rem', color: '#6b7280' }}>{item.curso} - {item.periodo} - {item.fecha}</p></div>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}><span className="status-badge active">{item.formato}</span><button className="btn btn-sm btn-secondary" style={{ color: 'var(--danger)' }} onClick={() => deleteFromHistorial(item.id)}><i className="fas fa-trash" /></button></div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {previewM && (
        <Modal title={`Vista Previa - ${tipo}`} icon="fa-eye" iconColor="var(--primary)" onClose={() => setPreviewM(false)} maxWidth="760px" footer={<><button className="btn btn-secondary" onClick={() => setPreviewM(false)}>Cerrar</button><button className="btn btn-primary" onClick={() => { handleGenerate(); setPreviewM(false) }} disabled={generating}><i className="fas fa-file-export" />Generar {formato}</button></>}>
          <div style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 12, padding: '1.5rem' }}>
            <div style={{ textAlign: 'center', marginBottom: '1.25rem', borderBottom: '2px solid #2563eb', paddingBottom: '1rem' }}>
              <h3 style={{ color: 'var(--primary)', marginBottom: '0.25rem' }}>EduNova - Sistema Academico</h3>
              <p style={{ fontSize: '0.85rem', color: '#6b7280' }}>{tipo} - {curso} - {periodo}</p>
              <p style={{ fontSize: '0.78rem', color: '#9ca3af' }}>Escala activa: {scaleHelpers.label}</p>
            </div>

            {loadingD ? (
              <div style={{ textAlign: 'center', padding: '1.5rem', color: '#6b7280' }}><i className="fas fa-spinner fa-spin" style={{ fontSize: '1.5rem', display: 'block', marginBottom: '0.5rem' }} />Cargando datos...</div>
            ) : reportState.rows.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '1.5rem', color: '#9ca3af' }}><i className="fas fa-inbox" style={{ fontSize: '2rem', display: 'block', marginBottom: '0.5rem' }} />No hay datos registrados para este curso y periodo.</div>
            ) : reportState.mode === 'attendance' ? (
              <div style={{ overflowX: 'auto' }}>
                <table className="data-table" style={{ fontSize: '0.82rem' }}>
                  <thead><tr><th>Estudiante</th><th style={{ textAlign: 'center' }}>Presentes</th><th style={{ textAlign: 'center' }}>Ausentes</th><th style={{ textAlign: 'center' }}>Tardanzas</th><th style={{ textAlign: 'center' }}>% Asistencia</th><th style={{ textAlign: 'center' }}>Estado</th></tr></thead>
                  <tbody>{reportState.rows.map(row => <tr key={row.id}><td>{row.name}</td><td style={{ textAlign: 'center' }}>{row.present}</td><td style={{ textAlign: 'center' }}>{row.absent}</td><td style={{ textAlign: 'center' }}>{row.late}</td><td style={{ textAlign: 'center', fontWeight: 700 }}>{row.percentageLabel}</td><td style={{ textAlign: 'center' }}><span className={`status-badge ${row.statusCls}`}>{row.status}</span></td></tr>)}</tbody>
                </table>
              </div>
            ) : (
              <>
                <div style={{ overflowX: 'auto' }}>
                  <table className="data-table" style={{ fontSize: '0.82rem' }}>
                    <thead><tr><th>Estudiante</th>{reportState.activityDefs.map(def => <th key={def.id} style={{ textAlign: 'center' }}>{def.label}</th>)}<th style={{ textAlign: 'center' }}>Promedio</th><th style={{ textAlign: 'center' }}>Estado</th></tr></thead>
                    <tbody>{reportState.rows.map(row => <tr key={row.id}><td>{row.name}</td>{reportState.activityDefs.map(def => <td key={def.id} style={{ textAlign: 'center' }}>{row.grades[def.label] ?? 0}</td>)}<td style={{ textAlign: 'center', fontWeight: 700 }}>{row.avg}</td><td style={{ textAlign: 'center' }}><span className={`status-badge ${row.statusCls}`}>{row.status}</span></td></tr>)}</tbody>
                  </table>
                </div>
                <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem', flexWrap: 'wrap' }}>
                  {[{ l: 'Aprobados', v: reportState.summary.approved || 0, c: 'var(--success)' }, { l: 'En riesgo', v: reportState.summary.warning || 0, c: 'var(--warning)' }, { l: 'Reprobados', v: reportState.summary.failed || 0, c: 'var(--danger)' }].map(item => <div key={item.l} style={{ flex: 1, textAlign: 'center', padding: '0.75rem', background: '#fff', borderRadius: 8, border: `1px solid ${item.c}` }}><p style={{ fontSize: '1.5rem', fontWeight: 700, color: item.c }}>{item.v}</p><p style={{ fontSize: '0.78rem', color: '#6b7280' }}>{item.l}</p></div>)}
                </div>
              </>
            )}
          </div>
        </Modal>
      )}
    </section>
  )
}
