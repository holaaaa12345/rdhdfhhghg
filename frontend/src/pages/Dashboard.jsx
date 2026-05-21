import { useEffect, useState } from 'react'
import { supabase } from '../services/supabaseClient.js'
import { getDayIndexMonday0, startOfWeekMondayLocal, toISODateLocal } from '../utils/dateUtils.js'

const isMissingColumn = (error, column = 'user_id') => {
  const code = String(error?.code || '')
  const message = String(error?.message || '').toLowerCase()
  const details = String(error?.details || '').toLowerCase()
  const combined = `${code} ${message} ${details}`
  return combined.includes('42703') || (combined.includes('column') && combined.includes(column) && combined.includes('does not exist'))
}

const periodToNumber = (period) => {
  const match = String(period || '').match(/(\d+)/)
  return match ? Number(match[1]) : 0
}

const averageWithWeights = (items) => {
  const totalWeight = items.reduce((sum, item) => sum + (Number(item.weight) || 0), 0)
  if (totalWeight === 0) return 0

  return items.reduce((sum, item) => {
    return sum + ((Number(item.grade) || 0) * (Number(item.weight) || 0) / totalWeight)
  }, 0)
}

const getCourseCode = (courseName) => {
  if (!courseName) return 'Sin curso'
  const parts = String(courseName).split(' - ')
  return parts[1] || parts[0]
}

const normalizeCourseCode = (value) => {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase()
}

const courseBadgeColor = (value) => {
  if (value >= 70) return { fill: 'green', text: 'var(--success)' }
  if (value >= 60) return { fill: 'blue', text: 'var(--warning)' }
  return { fill: 'red', text: 'var(--danger)' }
}

const buildFallbackCoursePerformance = (students) => {
  const grouped = new Map()

  students.forEach(student => {
    const key = student.course || 'Sin curso'
    const bucket = grouped.get(key) || []
    bucket.push(Number(student.avg) || 0)
    grouped.set(key, bucket)
  })

  return Array.from(grouped.entries())
    .map(([course, values]) => ({
      id: `students-${course}`,
      course,
      label: course,
      value: values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0,
      source: 'students',
    }))
    .sort((a, b) => a.course.localeCompare(b.course, 'es'))
}

const buildCoursePerformance = (grades, students) => {
  if (!grades.length) return buildFallbackCoursePerformance(students)

  const latestPeriodByCourse = new Map()
  grades.forEach(row => {
    const current = latestPeriodByCourse.get(row.course) || 0
    const next = periodToNumber(row.period)
    if (next >= current) latestPeriodByCourse.set(row.course, next)
  })

  const grouped = new Map()
  grades.forEach(row => {
    const latestPeriod = latestPeriodByCourse.get(row.course)
    if (periodToNumber(row.period) !== latestPeriod) return

    const key = `${row.course}|||${row.student_name}`
    const bucket = grouped.get(key) || []
    bucket.push(row)
    grouped.set(key, bucket)
  })

  const byCourse = new Map()
  grouped.forEach((items, key) => {
    const [course] = key.split('|||')
    const avg = averageWithWeights(items)
    const bucket = byCourse.get(course) || []
    bucket.push(avg)
    byCourse.set(course, bucket)
  })

  return Array.from(byCourse.entries())
    .map(([course, values]) => ({
      id: `grades-${course}-${latestPeriodByCourse.get(course)}`,
      course,
      label: getCourseCode(course),
      value: values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0,
      source: 'grades',
      period: latestPeriodByCourse.get(course),
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'es'))
}

const buildAlerts = (grades, students) => {
  const alerts = []

  if (grades.length) {
    const latestPeriodByCourse = new Map()
    grades.forEach(row => {
      const current = latestPeriodByCourse.get(row.course) || 0
      const next = periodToNumber(row.period)
      if (next >= current) latestPeriodByCourse.set(row.course, next)
    })

    const grouped = new Map()
    grades.forEach(row => {
      const latestPeriod = latestPeriodByCourse.get(row.course)
      if (periodToNumber(row.period) !== latestPeriod) return

      const key = `${row.course}|||${row.student_name}`
      const bucket = grouped.get(key) || []
      bucket.push(row)
      grouped.set(key, bucket)
    })

    grouped.forEach((items, key) => {
      const [course, studentName] = key.split('|||')
      const avg = averageWithWeights(items)
      if (avg >= 70) return

      alerts.push({
        student: studentName,
        course: getCourseCode(course),
        avg,
        level: avg < 60 ? 'danger' : 'warning',
        icon: avg < 60 ? 'fa-exclamation-circle' : 'fa-exclamation-triangle',
        title: avg < 60 ? 'Bajo rendimiento' : 'Riesgo académico',
        description: `Promedio actual: ${avg.toFixed(1)} en ${course}`,
      })
    })
  }

  if (!alerts.length) {
    students.forEach(student => {
      const avg = Number(student.avg) || 0
      if (avg >= 70) return

      alerts.push({
        student: student.name,
        course: student.course || 'Sin curso',
        avg,
        level: avg < 60 ? 'danger' : 'warning',
        icon: avg < 60 ? 'fa-exclamation-circle' : 'fa-exclamation-triangle',
        title: avg < 60 ? 'Bajo rendimiento' : 'Riesgo académico',
        description: `Promedio registrado: ${avg.toFixed(1)} en ${student.course || 'Sin curso'}`,
      })
    })
  }

  return alerts.sort((a, b) => a.avg - b.avg).slice(0, 5)
}

const buildTodayActivities = (weeklyRows) => {
  if (!weeklyRows.length) return []

  const now = new Date()
  const weekStart = startOfWeekMondayLocal(now)
  const weekStartKey = toISODateLocal(weekStart)
  const dayIndex = getDayIndexMonday0(now)

  // El horario semanal se maneja de lunes a viernes (0..4). Si es fin de semana, no hay actividades.
  if (dayIndex > 4) return []

  const filtered = weeklyRows
    .filter(row => row.week_start === weekStartKey && row.day_index === dayIndex)
    .sort((a, b) => String(a.time_slot).localeCompare(String(b.time_slot)))

  if (!filtered.length) return []

  return filtered.map(row => {
    const [time] = String(row.time_slot || '').split('-')
    return {
      time: time || row.time_slot,
      title: row.subject || 'Actividad',
      desc: row.description || 'Sin descripción',
    }
  })
}

const buildPlanningProgress = (plans, raItems) => {
  return plans
    .map(plan => {
      const items = raItems.filter(item => item.plan_id === plan.id)
      const completed = items.filter(item => item.status === 'active').length
      const pending = items.filter(item => item.status === 'pending').length
      const percent = items.length ? Math.round((completed / items.length) * 100) : 0
      const courseLabel = getCourseCode(plan.course)

      return {
        id: `plan-${plan.id}`,
        label: `${courseLabel} ${plan.year}`,
        pct: percent,
        color: percent >= 70 ? 'green' : percent >= 40 ? 'blue' : 'red',
        tc: percent >= 70 ? 'var(--success)' : percent >= 40 ? 'var(--primary)' : 'var(--danger)',
        detail: `${completed}/${items.length} RAs completados${pending ? `, ${pending} en progreso` : ''}`,
      }
    })
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 4)
}

export default function Dashboard({ onNavigate, showToast }) {
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState([])
  const [performance, setPerformance] = useState([])
  const [alerts, setAlerts] = useState([])
  const [todayActivities, setTodayActivities] = useState([])
  const [planningProgress, setPlanningProgress] = useState([])

  useEffect(() => {
    fetchDashboard()
  }, [])

  const fetchDashboard = async () => {
    setLoading(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()

      // Determine if the current user is privileged (Director/Coordinador) to see global data.
      // Docentes should only see their own data (user_id scoped).
      let privileged = false
      if (user) {
        const profileRes = await supabase
          .from('profiles')
          .select('role, status')
          .eq('id', user.id)
          .maybeSingle()
        if (!profileRes.error) {
          const role = String(profileRes.data?.role || '')
          const status = String(profileRes.data?.status || 'active')
          privileged = (role === 'Director' || role === 'Coordinador') && status === 'active'
        }
      }

      const [
        studentsRes,
        coursesRes,
        plansRes,
        raItemsRes,
        gradesRes,
        weeklyRes,
      ] = await Promise.all([
        // Prefer explicit per-user scoping for non-privileged roles.
        (user && !privileged)
          ? supabase.from('students').select('id, name, course, avg, status, user_id').eq('user_id', user.id)
          : supabase.from('students').select('id, name, course, avg, status'),
        (user && !privileged)
          ? supabase.from('courses').select('id, code, name, status, user_id').eq('user_id', user.id)
          : supabase.from('courses').select('id, code, name, status'),
        (user && !privileged)
          ? supabase.from('annual_plans').select('id, course, year, user_id').eq('user_id', user.id)
          : supabase.from('annual_plans').select('id, course, year'),
        supabase.from('ra_items').select('id, plan_id, status'),
        user
          ? supabase.from('grades').select('course, period, student_name, grade, weight').eq('user_id', user.id)
          : Promise.resolve({ data: [], error: null }),
        user
          ? supabase.from('weekly_planning').select('week_start, time_slot, day_index, subject, description').eq('user_id', user.id)
          : Promise.resolve({ data: [], error: null }),
      ])

      // Backward compatibility: if the schema doesn't have user_id yet, avoid leaking global demo data
      // to docentes by falling back to empty lists for the scoped queries.
      if (studentsRes.error) {
        if (!(user && !privileged && isMissingColumn(studentsRes.error, 'user_id'))) throw studentsRes.error
      }
      if (coursesRes.error) {
        if (!(user && !privileged && isMissingColumn(coursesRes.error, 'user_id'))) throw coursesRes.error
      }
      if (plansRes.error) {
        if (user && !privileged && isMissingColumn(plansRes.error, 'user_id')) {
          // We'll treat it as "no plans" for docentes if we can't scope safely.
        } else {
          throw plansRes.error
        }
      }
      if (raItemsRes.error) throw raItemsRes.error
      if (gradesRes.error) throw gradesRes.error
      if (weeklyRes.error) throw weeklyRes.error

      const students = studentsRes.error ? [] : (studentsRes.data || [])
      const courses = coursesRes.error ? [] : (coursesRes.data || [])
      const plans = plansRes.error ? [] : (plansRes.data || [])
      const raItems = raItemsRes.data || []
      const grades = gradesRes.data || []
      const weeklyRows = weeklyRes.data || []

      // Ensure dashboard "planning progress" only reflects courses that really exist in `courses`.
      // This prevents showing old/demo plans for course codes that the user never created.
      const courseCodeSet = new Set(
        (courses || [])
          .map((row) => normalizeCourseCode(row.code))
          .filter(Boolean)
      )

      const filteredPlans = courseCodeSet.size
        ? plans.filter((plan) => courseCodeSet.has(normalizeCourseCode(getCourseCode(plan.course))))
        : plans

      const planIdSet = new Set(filteredPlans.map((plan) => plan.id))
      // Important: if the user has no annual plans, we must NOT show global RA items.
      // RA items are meaningful only when they belong to a plan the user can see.
      const filteredRaItems = planIdSet.size
        ? raItems.filter((item) => planIdSet.has(item.plan_id))
        : []

      const performanceData = buildCoursePerformance(grades, students)
      const alertData = buildAlerts(grades, students)
      const activitiesData = buildTodayActivities(weeklyRows)
      const planningData = buildPlanningProgress(filteredPlans, filteredRaItems)

      const activeCourses = courses.filter(course => course.status === 'active').length || courses.length
      const totalCompletedRas = filteredRaItems.filter(item => item.status === 'active').length
      const totalPendingAlerts = alertData.length

      setStats([
        {
          icon: 'fa-users',
          color: 'blue',
          value: students.length,
          label: 'Estudiantes Activos',
          trend: 'up',
          txt: `${students.filter(s => Number(s.avg) >= 70).length} con rendimiento estable`,
        },
        {
          icon: 'fa-book',
          color: 'green',
          value: activeCourses,
          label: 'Cursos Asignados',
          trend: 'up',
          txt: `${courses.length} cursos registrados en el sistema`,
        },
        {
          icon: 'fa-clipboard-list',
          color: 'purple',
          value: totalCompletedRas,
          label: 'Planificaciones',
          trend: 'up',
          txt: `${filteredPlans.length} planes anuales, ${filteredRaItems.length} RAs totales`,
        },
        {
          icon: 'fa-exclamation-triangle',
          color: 'orange',
          value: totalPendingAlerts,
          label: 'Alertas Pendientes',
          trend: totalPendingAlerts > 0 ? 'down' : 'up',
          txt: totalPendingAlerts > 0 ? 'Requieren atención docente' : 'Sin alertas críticas',
        },
      ])

      setPerformance(performanceData)
      setAlerts(alertData)
      setTodayActivities(activitiesData)
      setPlanningProgress(planningData)
    } catch (error) {
      console.error(error)
      showToast?.('error', 'Error al cargar el dashboard')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section>
      <div className="page-header">
        <div className="breadcrumb">
          <a onClick={() => onNavigate('dashboard')}>Inicio</a><span>/</span><span>Dashboard</span>
        </div>
        <h2>Dashboard del Docente</h2>
        <p>Bienvenido de nuevo. Aquí tienes un resumen real de tu actividad.</p>
      </div>

      <div className="stats-grid">
        {loading
          ? Array.from({ length: 4 }).map((_, idx) => (
              <div className="stat-card" key={idx}>
                <div className="value">...</div>
                <div className="label">Cargando</div>
              </div>
            ))
          : stats.map(s => (
              <div className="stat-card" key={s.label}>
                <div className={`icon ${s.color}`}><i className={`fas ${s.icon}`} /></div>
                <div className="value">{s.value}</div>
                <div className="label">{s.label}</div>
                <div className={`trend ${s.trend}`}><i className={`fas fa-arrow-${s.trend}`} /><span>{s.txt}</span></div>
              </div>
            ))}
      </div>

      <div className="grid-2" style={{ marginBottom: '1.5rem' }}>
        <div className="card">
          <div className="card-header">
            <h3><i className="fas fa-chart-line" style={{ marginRight: 8, color: 'var(--primary)' }} />Rendimiento por Curso</h3>
          </div>
          <div className="card-body">
            {loading ? (
              <div style={{ textAlign: 'center', color: '#6b7280', padding: '1rem' }}>
                <i className="fas fa-spinner fa-spin" style={{ marginRight: 8 }} />
                Cargando rendimiento...
              </div>
            ) : performance.length === 0 ? (
              <div className="empty-state" style={{ padding: '1rem' }}>
                <i className="fas fa-chart-line" />
                <h3>Sin datos de rendimiento</h3>
                <p>Registra calificaciones para ver el promedio por curso.</p>
              </div>
            ) : (
              performance.map(p => {
                const tone = courseBadgeColor(p.value)
                return (
                  <div key={p.id || p.course} style={{ marginBottom: '0.75rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ fontWeight: 500 }}>{p.label}</span>
                      <span style={{ fontWeight: 600, color: tone.text }}>{p.value.toFixed(1)}</span>
                    </div>
                    <div className="progress-bar">
                      <div className={`fill ${tone.fill}`} style={{ width: `${Math.min(100, Math.max(0, p.value))}%` }} />
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3><i className="fas fa-bell" style={{ marginRight: 8, color: 'var(--warning)' }} />Alertas de Rendimiento</h3>
          </div>
          <div className="card-body">
            {loading ? (
              <div style={{ textAlign: 'center', color: '#6b7280', padding: '1rem' }}>
                <i className="fas fa-spinner fa-spin" style={{ marginRight: 8 }} />
                Cargando alertas...
              </div>
            ) : alerts.length === 0 ? (
              <div className="alert-card success">
                <i className="fas fa-check-circle icon" />
                <div>
                  <strong>Sin alertas activas</strong>
                  <p style={{ fontSize: '0.85rem', color: '#6b7280', marginTop: 4 }}>
                    No hay estudiantes en bajo rendimiento o riesgo académico.
                  </p>
                </div>
              </div>
            ) : (
              alerts.map(alert => (
                <div className={`alert-card ${alert.level}`} key={`${alert.student}-${alert.course}`}>
                  <i className={`fas ${alert.icon} icon`} />
                  <div>
                    <strong>{alert.student}</strong> - {alert.title}
                    <p style={{ fontSize: '0.85rem', color: '#6b7280', marginTop: 4 }}>{alert.description}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-header"><h3><i className="fas fa-tasks" style={{ marginRight: 8, color: 'var(--success)' }} />Actividades Hoy</h3></div>
          <div className="card-body">
            {loading ? (
              <div style={{ textAlign: 'center', color: '#6b7280', padding: '1rem' }}>
                <i className="fas fa-spinner fa-spin" style={{ marginRight: 8 }} />
                Cargando agenda...
              </div>
            ) : todayActivities.length === 0 ? (
              <div className="empty-state" style={{ padding: '1rem' }}>
                <i className="fas fa-calendar-day" />
                <h3>Sin actividades para hoy</h3>
                <p>Agrega clases en la planificación semanal para verlas aquí.</p>
              </div>
            ) : (
              todayActivities.map(activity => (
                <div className="activity-item" key={`${activity.time}-${activity.title}`}>
                  <div className="time">{activity.time}</div>
                  <div className="line" />
                  <div className="content"><h4>{activity.title}</h4><p>{activity.desc}</p></div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-header"><h3><i className="fas fa-percentage" style={{ marginRight: 8, color: 'var(--secondary)' }} />Progreso de Planificación</h3></div>
          <div className="card-body">
            {loading ? (
              <div style={{ textAlign: 'center', color: '#6b7280', padding: '1rem' }}>
                <i className="fas fa-spinner fa-spin" style={{ marginRight: 8 }} />
                Cargando progreso...
              </div>
            ) : planningProgress.length === 0 ? (
              <div className="empty-state" style={{ padding: '1rem' }}>
                <i className="fas fa-sitemap" />
                <h3>Sin planes registrados</h3>
                <p>Crea RAs en planificación anual para visualizar su avance.</p>
              </div>
            ) : (
              planningProgress.map(p => (
                <div key={p.id || p.label} style={{ marginBottom: '1.5rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ fontWeight: 500 }}>{p.label}</span>
                    <span style={{ color: p.tc, fontWeight: 600 }}>{p.pct}%</span>
                  </div>
                  <div className="progress-bar"><div className={`fill ${p.color}`} style={{ width: `${p.pct}%` }} /></div>
                  <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: 6 }}>{p.detail}</div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
