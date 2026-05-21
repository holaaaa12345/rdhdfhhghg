import { useEffect, useMemo, useState } from 'react'
import Modal from '../components/Modal.jsx'
import { supabase } from '../services/supabaseClient.js'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { recordAuditEvent } from '../services/auditLogger.js'
import {
  buildActivitySummary,
  buildAnnualPlanMeta,
  DEFAULT_ANNUAL_TEMPLATE_STRUCTURE,
  mergePlanMetaWithTemplate,
  normalizePlanningTemplate,
} from '../services/planningTemplateService.js'
import { ACADEMIC_SUBJECT_OPTIONS, buildAcademicCourse } from '../data/projectOptions.js'
import { studentsService } from '../services/academicServices.js'
import { planningShareService } from '../services/api.js'

const YEARS = [2026, 2025, 2024]

const normalizePlainText = (value) => {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
}

const sanitizeForPdf = (value) => {
  // jsPDF (fonts base) no siempre renderiza bien simbolos/bullets, asi que los normalizamos.
  return normalizePlainText(value)
    .replace(/[✓✔]/g, '')
    .replace(/[⚠]/g, '')
    .replace(/[✕✖]/g, '')
    .replace(/[•·]/g, '-')
    .replace(/[–—]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
}

const arrayBufferToBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

const svgToPngDataUrl = async (svgText, width = 220, height = 220) => {
  if (typeof window === 'undefined') return null

  return await new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        ctx.clearRect(0, 0, width, height)
        ctx.drawImage(img, 0, 0, width, height)
        resolve(canvas.toDataURL('image/png'))
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`
  })
}

const STATUS_MAP = {
  active: { label: 'Completado', cls: 'active', icon: 'fa-check-circle', color: 'var(--success)' },
  pending: { label: 'En progreso', cls: 'pending', icon: 'fa-spinner', color: 'var(--warning)' },
  inactive: { label: 'Pendiente', cls: 'inactive', icon: 'fa-circle', color: '#d1d5db' },
}

const emptyForm = {
  title: '',
  desc: '',
  weekStart: '',
  weekEnd: '',
  hours: '',
  status: 'inactive',
  activities: '',
  domainRA: '',
  elementCode: '',
  elementTitle: '',
  domainEC: '',
  learningActivities: '',
  activityPeriod: '',
  evaluationActivities: '',
  evaluationInstruments: '',
  conceptualContent: '',
  proceduralContent: '',
  attitudinalContent: '',
}

const buildMetaDefaults = (course, year) => buildAnnualPlanMeta(course, year)

const mapRows = (items = []) => items.map((row, index) => ({
  id: row.id || `snapshot-${index}`,
  code: row.code || '',
  title: row.title || '',
  desc: row.description || '',
  status: row.status || 'inactive',
  weekStart: Number(row.weeks_start) || 0,
  weekEnd: Number(row.weeks_end) || 0,
  hours: Number(row.hours) || 0,
  activities: Number(row.activities) || 0,
  domainRA: row.domain_ra || '',
  elementCode: row.element_code || '',
  elementTitle: row.element_title || '',
  domainEC: row.domain_ec || '',
  learningActivities: row.learning_activities || '',
  activityPeriod: row.activity_period || '',
  evaluationActivities: row.evaluation_activities || '',
  evaluationInstruments: row.evaluation_instruments || '',
  conceptualContent: row.conceptual_content || '',
  proceduralContent: row.procedural_content || '',
  attitudinalContent: row.attitudinal_content || '',
}))

const snapshotRows = (rows = []) => rows.map(row => ({
  code: row.code,
  title: row.title,
  description: row.desc,
  status: row.status,
  weeks_start: Number(row.weekStart) || 0,
  weeks_end: Number(row.weekEnd) || 0,
  hours: Number(row.hours) || 0,
  activities: Number(row.activities) || 0,
  domain_ra: row.domainRA || null,
  element_code: row.elementCode || null,
  element_title: row.elementTitle || null,
  domain_ec: row.domainEC || null,
  learning_activities: row.learningActivities || null,
  activity_period: row.activityPeriod || null,
  evaluation_activities: row.evaluationActivities || null,
  evaluation_instruments: row.evaluationInstruments || null,
  conceptual_content: row.conceptualContent || null,
  procedural_content: row.proceduralContent || null,
  attitudinal_content: row.attitudinalContent || null,
}))

const normalizePlanMeta = (plan = {}, course, year) => {
  const defaults = buildMetaDefaults(course, year)
  return {
    ...defaults,
    plan_kind: plan.plan_kind || defaults.plan_kind || 'tecnica',
    institution_name: plan.institution_name || defaults.institution_name,
    technical_degree: plan.technical_degree || defaults.technical_degree,
    module_name: plan.module_name || defaults.module_name,
    module_code: plan.module_code || defaults.module_code,
    teacher_name: plan.teacher_name || defaults.teacher_name,
    uc_name: plan.uc_name || defaults.uc_name,
    uc_code: plan.uc_code || defaults.uc_code,
    start_date: plan.start_date || defaults.start_date,
    end_date: plan.end_date || defaults.end_date,
    hours_per_week: Number(plan.hours_per_week) || defaults.hours_per_week || '',
    template_reference: plan.template_reference || defaults.template_reference,
    course,
    year,
  }
}

const summarizeRows = (rows = []) => ({
  total_ras: rows.length,
  total_ec: rows.filter(row => row.elementCode || row.elementTitle).length,
  completed: rows.filter(row => row.status === 'active').length,
  pending: rows.filter(row => row.status === 'pending').length,
  total_hours: rows.reduce((sum, row) => sum + (Number(row.hours) || 0), 0),
})

const parseVersionSnapshot = (snapshot) => {
  if (Array.isArray(snapshot)) {
    return { meta: null, rows: mapRows(snapshot) }
  }

  return {
    meta: snapshot?.meta || null,
    rows: mapRows(snapshot?.rows || []),
  }
}

const getHint = (structure, key, fallback) => {
  return structure?.fieldHints?.[key] || fallback || ''
}

const pickLatestRow = (rows = []) => {
  if (!Array.isArray(rows) || rows.length === 0) return null
  return [...rows].sort((a, b) => {
    const aDate = new Date(a.created_at || 0).getTime()
    const bDate = new Date(b.created_at || 0).getTime()
    if (bDate !== aDate) return bDate - aDate
    return Number(b.id || 0) - Number(a.id || 0)
  })[0]
}

const isPlanningSchemaIssue = (error) => {
  const message = String(error?.message || '').toLowerCase()
  const details = String(error?.details || '').toLowerCase()
  const hint = String(error?.hint || '').toLowerCase()
  const code = String(error?.code || '').toLowerCase()
  const combined = `${message} ${details} ${hint} ${code}`

  return (
    combined.includes('template_type') ||
    combined.includes('structure_json') ||
    combined.includes('is_system_template') ||
    combined.includes('institution_name') ||
    combined.includes('technical_degree') ||
    combined.includes('module_name') ||
    combined.includes('module_code') ||
    combined.includes('teacher_name') ||
    combined.includes('uc_name') ||
    combined.includes('uc_code') ||
    combined.includes('hours_per_week') ||
    combined.includes('template_reference') ||
    combined.includes('domain_ra') ||
    combined.includes('element_code') ||
    combined.includes('element_title') ||
    combined.includes('domain_ec') ||
    combined.includes('learning_activities') ||
    combined.includes('evaluation_instruments') ||
    combined.includes('conceptual_content') ||
    combined.includes('procedural_content') ||
    combined.includes('attitudinal_content') ||
    combined.includes('planning_versions') ||
    combined.includes('does not exist') ||
    combined.includes('42703') ||
    combined.includes('42p01')
  )
}

export function AnnualPlanning({ showToast, onNavigate }) {
  const [authUserId, setAuthUserId] = useState('')
  const [subject, setSubject] = useState(ACADEMIC_SUBJECT_OPTIONS[0] || '')
  const [courseOptions, setCourseOptions] = useState([])
  const [section, setSection] = useState('')
  const [year, setYear] = useState(YEARS[0])
  const [plans, setPlans] = useState([])
  const [planId, setPlanId] = useState(null)
  const [planMeta, setPlanMeta] = useState(buildMetaDefaults(buildAcademicCourse(ACADEMIC_SUBJECT_OPTIONS[0] || '', ''), YEARS[0]))
  const [versions, setVersions] = useState([])
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [templateLoading, setTemplateLoading] = useState(false)
  const [addModal, setAddModal] = useState(false)
  const [editModal, setEditModal] = useState(false)
  const [viewModal, setViewModal] = useState(false)
  const [deleteModal, setDeleteModal] = useState(false)
  const [vModal, setVModal] = useState(false)
  const [cModal, setCModal] = useState(false)
  const [metaModal, setMetaModal] = useState(false)
  const [templateModal, setTemplateModal] = useState(false)
  const [sendingShare, setSendingShare] = useState(false)
  const [selected, setSelected] = useState(null)
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [pendingTemplateId, setPendingTemplateId] = useState('')
  const [form, setForm] = useState(emptyForm)
  const [metaForm, setMetaForm] = useState(buildMetaDefaults(buildAcademicCourse(ACADEMIC_SUBJECT_OPTIONS[0] || '', ''), YEARS[0]))
  const [errors, setErrors] = useState({})
  const [metaErrors, setMetaErrors] = useState({})
  const [copying, setCopying] = useState(false)
  const [savingMeta, setSavingMeta] = useState(false)
  const [copyForm, setCopyForm] = useState({
    subject: ACADEMIC_SUBJECT_OPTIONS[0] || '',
    section: '',
    year: YEARS[1] || YEARS[0],
  })
  const course = buildAcademicCourse(subject, section)

  // Draft persistence:
  // When the user copies text from another tab/app and comes back, the browser may refresh,
  // the session may re-check, or the page may remount. To avoid losing what was typed but not saved yet,
  // we keep a localStorage draft for the "Datos generales" and "RA" modals.
  const safeDraftSlug = (value) => String(value || '').replace(/[^a-z0-9]+/gi, '_').slice(0, 80)
  // Use course+year only so drafts survive planId timing differences (planId can be null during first load).
  const draftScope = `${safeDraftSlug(course)}_${year}`
  // Important: the draft key must be stable even if the auth state briefly resets
  // (for example when the tab loses focus and the session re-check runs).
  // If we include authUserId, the key can flip between "anon" and the real uid and the draft
  // looks like it disappeared. We scope by course+year only which is enough for this UI.
  const draftKey = (kind, extra = '') =>
    `edunova:annual:draft:${kind}:${draftScope}${extra ? `:${extra}` : ''}`
  const uiStateKey = `edunova:annual:ui:${draftScope}`
  const [pendingUiRestore, setPendingUiRestore] = useState(null)
  const [uiRestoreApplied, setUiRestoreApplied] = useState(false)

  useEffect(() => {
    ;(async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser()
        setAuthUserId(user?.id || '')

        const codes = await studentsService.fetchCourseOptions()
        setCourseOptions(codes)
        setSection((current) => current || codes[0] || '')
        setCopyForm((current) => ({ ...current, section: current.section || codes[0] || '' }))
      } catch (err) {
        console.error(err)
      }
    })()
  }, [])

  // Persist which modal was open (Datos generales / Agregar RA / Editar RA).
  // Browsers can discard/reload a tab when you alt-tab to another window; drafts help preserve text,
  // and this UI state lets us reopen the same modal automatically after remount.
  useEffect(() => {
    if (typeof window === 'undefined') return
    let open = null
    if (metaModal) open = 'meta'
    else if (addModal) open = 'ra_add'
    else if (editModal) open = 'ra_edit'

    try {
      if (!open) {
        window.localStorage.removeItem(uiStateKey)
        return
      }
      window.localStorage.setItem(uiStateKey, JSON.stringify({
        open,
        raId: open === 'ra_edit' && selected?.id ? String(selected.id) : null,
        ts: Date.now(),
      }))
    } catch {
      // ignore
    }
  }, [uiStateKey, metaModal, addModal, editModal, selected?.id])

  // Read the last UI state for this course+year scope so we can restore it after reload/remount.
  useEffect(() => {
    if (typeof window === 'undefined') return
    setUiRestoreApplied(false)
    try {
      const raw = window.localStorage.getItem(uiStateKey)
      if (!raw) {
        setPendingUiRestore(null)
        return
      }
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || !parsed.open) {
        setPendingUiRestore(null)
        return
      }
      const ts = Number(parsed.ts || 0)
      // Only restore "recent" sessions; otherwise we might reopen modals days later unexpectedly.
      if (ts && Date.now() - ts > 2 * 60 * 60 * 1000) {
        window.localStorage.removeItem(uiStateKey)
        setPendingUiRestore(null)
        return
      }
      setPendingUiRestore({
        open: String(parsed.open || ''),
        raId: parsed.raId ? String(parsed.raId) : null,
      })
    } catch {
      setPendingUiRestore(null)
    }
  }, [uiStateKey])

  // Restore and autosave drafts for Meta and RA modals.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!metaModal) return
    try {
      const raw = window.localStorage.getItem(draftKey('meta'))
      if (!raw) return
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        setMetaForm((current) => ({ ...current, ...parsed }))
      }
    } catch {
      // ignore
    }
  }, [metaModal, authUserId, course, year, planId])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!metaModal) return
    const t = window.setTimeout(() => {
      try {
        window.localStorage.setItem(draftKey('meta'), JSON.stringify(metaForm))
      } catch {
        // ignore
      }
    }, 250)
    return () => window.clearTimeout(t)
  }, [metaModal, metaForm, authUserId, course, year, planId])

  const isRaModalOpen = addModal || editModal
  const raDraftId = selected?.id ? String(selected.id) : (addModal ? 'new' : '')

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!isRaModalOpen) return
    try {
      const raw = window.localStorage.getItem(draftKey('ra', raDraftId))
      if (!raw) return
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        setForm((current) => ({ ...current, ...parsed }))
      }
    } catch {
      // ignore
    }
  }, [isRaModalOpen, raDraftId, authUserId, course, year, planId])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!isRaModalOpen) return
    const t = window.setTimeout(() => {
      try {
        window.localStorage.setItem(draftKey('ra', raDraftId), JSON.stringify(form))
      } catch {
        // ignore
      }
    }, 250)
    return () => window.clearTimeout(t)
  }, [isRaModalOpen, raDraftId, form, authUserId, course, year, planId])

  // When the tab is closed or refreshed while a modal is open, force-save the latest draft.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const handler = () => {
      try {
        if (metaModal) window.localStorage.setItem(draftKey('meta'), JSON.stringify(metaForm))
        if (isRaModalOpen) window.localStorage.setItem(draftKey('ra', raDraftId), JSON.stringify(form))
      } catch {
        // ignore
      }
    }
    window.addEventListener('beforeunload', handler)
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') handler()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('beforeunload', handler)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [metaModal, metaForm, isRaModalOpen, raDraftId, form, course, year])

  useEffect(() => {
    fetchTemplates()
  }, [])

  useEffect(() => {
    if (!String(section || '').trim()) {
      setPlans([])
      setPlanId(null)
      setLoading(false)
      return
    }
    fetchPlan()
  }, [course, year, section])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const storedTemplateId = window.localStorage.getItem('edunovaAnnualTemplateId')
    if (storedTemplateId) setPendingTemplateId(storedTemplateId)
  }, [])

  useEffect(() => {
    if (!pendingTemplateId || !templates.length || !planId) return
    const template = templates.find(item => String(item.id) === String(pendingTemplateId))
    if (!template) {
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem('edunovaAnnualTemplateId')
      }
      setPendingTemplateId('')
      return
    }

    applyTemplate(template, { openMeta: true, persistSelection: false })

    if (typeof window !== 'undefined') {
      window.localStorage.removeItem('edunovaAnnualTemplateId')
    }
    setPendingTemplateId('')
  }, [pendingTemplateId, templates, planId])

  const activeTemplate = useMemo(() => {
    return templates.find(template => template.n === planMeta.template_reference) || null
  }, [templates, planMeta.template_reference])

  const activeStructure = activeTemplate?.structure || DEFAULT_ANNUAL_TEMPLATE_STRUCTURE

  const fetchTemplates = async () => {
    setTemplateLoading(true)
    try {
      const { data, error } = await supabase
        .from('templates')
        .select('*')
        .eq('template_type', 'annual_ra')
        .order('created_at', { ascending: true })
      if (error) throw error
      const rows = (data || []).map(normalizePlanningTemplate)
      setTemplates(rows)
      if (!selectedTemplateId && rows.length > 0) setSelectedTemplateId(String(rows[0].id))
    } catch (error) {
      console.error(error)
      if (isPlanningSchemaIssue(error)) {
        showToast('warning', 'Falta actualizar Supabase para Plantificacion Anual. Ejecuta planning_institutional_upgrade.sql')
      }
      setTemplates([])
    } finally {
      setTemplateLoading(false)
    }
  }

  const fetchVersions = async (targetPlanId, fallbackRows = [], fallbackMeta = null) => {
    if (!targetPlanId) return
    setVersionsLoading(true)
    try {
      const { data, error } = await supabase
        .from('planning_versions')
        .select('*')
        .eq('plan_id', targetPlanId)
        .order('version_number', { ascending: false })
      if (error) throw error
      const rows = data || []
      setVersions(rows)
      if (rows.length === 0 && (fallbackRows.length > 0 || fallbackMeta)) {
        await createVersion(targetPlanId, fallbackRows, 'baseline', null, fallbackMeta || planMeta)
      }
    } catch (error) {
      console.error(error)
      setVersions([])
    } finally {
      setVersionsLoading(false)
    }
  }

  const createVersion = async (targetPlanId, rows, action = 'update', source = null, metaOverride = null) => {
    if (!targetPlanId) return false
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', user?.id).maybeSingle()
      const { count } = await supabase
        .from('planning_versions')
        .select('id', { count: 'exact', head: true })
        .eq('plan_id', targetPlanId)

      const snapshot = {
        meta: metaOverride || planMeta,
        rows: snapshotRows(rows),
      }

      const { error } = await supabase.from('planning_versions').insert([{
        plan_id: targetPlanId,
        course,
        year,
        action,
        version_number: (count || 0) + 1,
        snapshot,
        summary: summarizeRows(rows),
        source_course: source?.course || null,
        source_year: source?.year || null,
        created_by: user?.id || null,
        created_by_name: profile?.full_name || user?.email || 'Director',
        created_by_email: user?.email || null,
      }])
      if (error) throw error
      await fetchVersions(targetPlanId)
      return true
    } catch (error) {
      console.error(error)
      return false
    }
  }

  const replacePlanState = async (rows, nextMeta = planMeta) => {
    if (!planId) return false
    try {
      const { error: metaError } = await supabase
        .from('annual_plans')
        .update({
          plan_kind: (nextMeta.plan_kind || 'tecnica').toLowerCase(),
          institution_name: nextMeta.institution_name || null,
          technical_degree: nextMeta.technical_degree || null,
          module_name: nextMeta.module_name || null,
          module_code: nextMeta.module_code || null,
          teacher_name: nextMeta.teacher_name || null,
          uc_name: nextMeta.uc_name || null,
          uc_code: nextMeta.uc_code || null,
          start_date: nextMeta.start_date || null,
          end_date: nextMeta.end_date || null,
          hours_per_week: nextMeta.hours_per_week ? Number(nextMeta.hours_per_week) : null,
          template_reference: nextMeta.template_reference || null,
        })
        .eq('id', planId)
      if (metaError) throw metaError

      const { error: deleteError } = await supabase.from('ra_items').delete().eq('plan_id', planId)
      if (deleteError) throw deleteError

      if (rows.length > 0) {
        const payload = snapshotRows(rows).map(row => ({ ...row, plan_id: planId }))
        const { error: insertError } = await supabase.from('ra_items').insert(payload)
        if (insertError) throw insertError
      }

      setPlanMeta(nextMeta)
      setMetaForm(nextMeta)
      setPlans(rows)
      return true
    } catch (error) {
      console.error(error)
      return false
    }
  }

  const restoreVersion = async (version) => {
    const parsed = parseVersionSnapshot(version.snapshot)
    const restoredMeta = parsed.meta ? { ...parsed.meta, course, year } : planMeta
    const restored = await replacePlanState(parsed.rows, restoredMeta)

    if (!restored) {
      showToast('error', 'No se pudo restaurar la version')
      return
    }

    const { data: { user } } = await supabase.auth.getUser()
    await supabase
      .from('planning_versions')
      .update({
        restored_at: new Date().toISOString(),
        restored_by: user?.id || null,
        restored_by_email: user?.email || null,
      })
      .eq('id', version.id)

    await createVersion(
      planId,
      parsed.rows,
      'restore',
      { course: version.source_course || version.course, year: version.source_year || version.year },
      restoredMeta,
    )

    await recordAuditEvent({
      user,
      module: 'Planificacion Anual',
      action: 'Restauracion de version',
      details: `Se restauro la version v${version.version_number} del plan ${course} - ${year}`,
      type: 'planning',
    })

    setVModal(false)
    showToast('success', 'Version restaurada correctamente')
  }

  const fetchPlan = async () => {
    setLoading(true)
    try {
      const { data: planRows, error: planError } = await supabase
        .from('annual_plans')
        .select('*')
        .eq('course', course)
        .eq('year', year)
        .order('created_at', { ascending: false, nullsFirst: false })

      if (planError) throw planError
      let plan = pickLatestRow(planRows)

      if (!plan?.id) {
        const defaults = buildMetaDefaults(course, year)
         const { data: newPlan, error: createError } = await supabase
           .from('annual_plans')
           .insert([{
             course,
             year,
             plan_kind: (defaults.plan_kind || 'tecnica').toLowerCase(),
             institution_name: defaults.institution_name,
             technical_degree: defaults.technical_degree,
             module_name: defaults.module_name || null,
             module_code: defaults.module_code || null,
             teacher_name: defaults.teacher_name || null,
            uc_name: defaults.uc_name || null,
            uc_code: defaults.uc_code || null,
            start_date: defaults.start_date || null,
            end_date: defaults.end_date || null,
            hours_per_week: defaults.hours_per_week ? Number(defaults.hours_per_week) : null,
            template_reference: defaults.template_reference || null,
          }])
          .select('*')
          .single()
        if (createError) throw createError
        plan = newPlan
      }

      const normalizedMeta = normalizePlanMeta(plan, course, year)
      setPlanId(plan.id)
      setPlanMeta(normalizedMeta)
      setMetaForm(normalizedMeta)

      const { data: ras, error: rasError } = await supabase
        .from('ra_items')
        .select('*')
        .eq('plan_id', plan.id)
        .order('created_at', { ascending: true })
      if (rasError) throw rasError

      const rows = mapRows(ras)
      setPlans(rows)
      await fetchVersions(plan.id, rows, normalizedMeta)
    } catch (error) {
      console.error(error)
      if (isPlanningSchemaIssue(error)) {
        showToast('error', 'Falta la migracion de Supabase para esta matriz. Ejecuta planning_institutional_upgrade.sql y planning_versions.sql')
      } else {
        showToast('error', 'Error al cargar la planificacion')
      }
    } finally {
      setLoading(false)
    }
  }

  const setF = (key, value) => setForm(prev => ({ ...prev, [key]: value }))
  const setMF = (key, value) => setMetaForm(prev => ({ ...prev, [key]: value }))

  const validate = () => {
    const nextErrors = {}
    if (!form.title.trim()) nextErrors.title = 'El titulo del RA es requerido'
    if (!form.desc.trim()) nextErrors.desc = 'La descripcion general es requerida'
    if (!form.domainRA.trim()) nextErrors.domainRA = 'Define el nivel de dominio del RA'
    if (!form.elementCode.trim()) nextErrors.elementCode = 'El codigo del EC es requerido'
    if (!form.elementTitle.trim()) nextErrors.elementTitle = 'El titulo del EC es requerido'
    if (!form.domainEC.trim()) nextErrors.domainEC = 'Define el nivel de dominio del EC'
    if (!form.learningActivities.trim()) nextErrors.learningActivities = 'Describe las actividades de aprendizaje'
    if (!form.activityPeriod.trim()) nextErrors.activityPeriod = 'Indica el periodo de realizacion'
    if (!form.evaluationActivities.trim()) nextErrors.evaluationActivities = 'Describe la evaluacion'
    if (!form.evaluationInstruments.trim()) nextErrors.evaluationInstruments = 'Indica los instrumentos'
    if (!form.conceptualContent.trim()) nextErrors.conceptualContent = 'Agrega contenidos conceptuales'
    if (!form.proceduralContent.trim()) nextErrors.proceduralContent = 'Agrega contenidos procedimentales'
    if (!form.attitudinalContent.trim()) nextErrors.attitudinalContent = 'Agrega contenidos actitudinales'
    if (!form.weekStart) nextErrors.weekStart = 'Requerido'
    if (!form.weekEnd) nextErrors.weekEnd = 'Requerido'
    if (Number(form.weekEnd) < Number(form.weekStart)) nextErrors.weekEnd = 'Debe ser mayor o igual al inicio'
    if (!form.hours || Number(form.hours) <= 0) nextErrors.hours = 'Ingresa las horas'
    setErrors(nextErrors)
    return Object.keys(nextErrors).length === 0
  }

  const validateMeta = (target = metaForm) => {
    const nextErrors = {}
    const kind = (target.plan_kind || 'tecnica').toLowerCase()
    if (!target.institution_name.trim()) nextErrors.institution_name = 'La institucion es requerida'
    if (!target.technical_degree.trim()) nextErrors.technical_degree = kind === 'academica' ? 'El nivel o modalidad es requerido' : 'El bachillerato tecnico es requerido'
    if (!target.module_name.trim()) nextErrors.module_name = kind === 'academica' ? 'La asignatura es requerida' : 'El modulo formativo es requerido'
    if (kind !== 'academica' && !target.module_code.trim()) nextErrors.module_code = 'El codigo del modulo es requerido'
    if (!target.teacher_name.trim()) nextErrors.teacher_name = 'El docente es requerido'
    if (!target.uc_name.trim()) nextErrors.uc_name = kind === 'academica' ? 'La competencia u objetivo es requerido' : 'La unidad de competencia es requerida'
    if (kind !== 'academica' && !target.uc_code.trim()) nextErrors.uc_code = 'El codigo UC es requerido'
    if (!target.start_date) nextErrors.start_date = 'Indica la fecha de inicio'
    if (!target.end_date) nextErrors.end_date = 'Indica la fecha de termino'
    if (target.start_date && target.end_date && target.end_date < target.start_date) {
      nextErrors.end_date = 'La fecha final debe ser posterior'
    }
    if (!target.hours_per_week || Number(target.hours_per_week) <= 0) nextErrors.hours_per_week = 'Indica las horas por semana'
    setMetaErrors(nextErrors)
    return Object.keys(nextErrors).length === 0
  }

  const nextCode = () => {
    const base = (planMeta.module_code || subject.slice(0, 3) || 'RA')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8)
    return `RA-${base}-${String(plans.length + 1).padStart(2, '0')}`
  }

  const openAdd = () => {
    setForm(emptyForm)
    setErrors({})
    setAddModal(true)
  }

  const handleAdd = async () => {
    if (!validate()) return
    try {
      const { data, error } = await supabase
        .from('ra_items')
        .insert([{
          plan_id: planId,
          code: nextCode(),
          title: form.title.trim(),
          description: form.desc.trim(),
          status: form.status,
          weeks_start: Number(form.weekStart),
          weeks_end: Number(form.weekEnd),
          hours: Number(form.hours),
          activities: Number(form.activities) || 0,
          domain_ra: form.domainRA.trim(),
          element_code: form.elementCode.trim(),
          element_title: form.elementTitle.trim(),
          domain_ec: form.domainEC.trim(),
          learning_activities: form.learningActivities.trim(),
          activity_period: form.activityPeriod.trim(),
          evaluation_activities: form.evaluationActivities.trim(),
          evaluation_instruments: form.evaluationInstruments.trim(),
          conceptual_content: form.conceptualContent.trim(),
          procedural_content: form.proceduralContent.trim(),
          attitudinal_content: form.attitudinalContent.trim(),
        }])
        .select()
        .single()
      if (error) throw error

      const nextRows = [...plans, ...mapRows([data])]
      setPlans(nextRows)
      await createVersion(planId, nextRows, 'create')

      const { data: { user } } = await supabase.auth.getUser()
      await recordAuditEvent({
        user,
        module: 'Planificacion Anual',
        action: 'Creacion de RA institucional',
        details: `Se agrego ${form.title.trim()} al plan ${course} - ${year}`,
        type: 'planning',
      })

      // Clear local draft on successful save.
      try {
        if (typeof window !== 'undefined') window.localStorage.removeItem(draftKey('ra', 'new'))
      } catch {
        // ignore
      }

      setAddModal(false)
      showToast('success', 'Resultado de Aprendizaje agregado a la matriz')
    } catch (error) {
      console.error(error)
      showToast('error', `Error: ${error.message || 'No se pudo agregar el RA'}`)
    }
  }

  const openEdit = (row) => {
    setSelected(row)
    setForm({
      title: row.title,
      desc: row.desc,
      weekStart: row.weekStart,
      weekEnd: row.weekEnd,
      hours: row.hours,
      status: row.status,
      activities: row.activities,
      domainRA: row.domainRA,
      elementCode: row.elementCode,
      elementTitle: row.elementTitle,
      domainEC: row.domainEC,
      learningActivities: row.learningActivities,
      activityPeriod: row.activityPeriod,
      evaluationActivities: row.evaluationActivities,
      evaluationInstruments: row.evaluationInstruments,
      conceptualContent: row.conceptualContent,
      proceduralContent: row.proceduralContent,
      attitudinalContent: row.attitudinalContent,
    })
    setErrors({})
    setEditModal(true)
  }

  // Restore the last-open modal automatically after a browser discard/reload.
  // Drafts restore the text; this restores *where* the user was editing.
  useEffect(() => {
    if (uiRestoreApplied) return
    if (!pendingUiRestore || !pendingUiRestore.open) return

    // Avoid reopening modals while the main plan is still loading and about to overwrite state.
    if (loading) return

    if (pendingUiRestore.open === 'meta') {
      setMetaModal(true)
      setUiRestoreApplied(true)
      return
    }

    if (pendingUiRestore.open === 'ra_add') {
      openAdd()
      setUiRestoreApplied(true)
      return
    }

    if (pendingUiRestore.open === 'ra_edit') {
      const targetId = pendingUiRestore.raId ? String(pendingUiRestore.raId) : ''
      if (!targetId) {
        setUiRestoreApplied(true)
        return
      }

      const row = (plans || []).find((item) => String(item?.id) === targetId)
      if (row) {
        openEdit(row)
      }
      // Even if we didn't find it (deleted/moved), don't keep trying forever.
      setUiRestoreApplied(true)
    }
  }, [pendingUiRestore, uiRestoreApplied, loading, plans])

  const handleEdit = async () => {
    if (!validate()) return
    try {
      const { error } = await supabase
        .from('ra_items')
        .update({
          title: form.title.trim(),
          description: form.desc.trim(),
          status: form.status,
          weeks_start: Number(form.weekStart),
          weeks_end: Number(form.weekEnd),
          hours: Number(form.hours),
          activities: Number(form.activities) || 0,
          domain_ra: form.domainRA.trim(),
          element_code: form.elementCode.trim(),
          element_title: form.elementTitle.trim(),
          domain_ec: form.domainEC.trim(),
          learning_activities: form.learningActivities.trim(),
          activity_period: form.activityPeriod.trim(),
          evaluation_activities: form.evaluationActivities.trim(),
          evaluation_instruments: form.evaluationInstruments.trim(),
          conceptual_content: form.conceptualContent.trim(),
          procedural_content: form.proceduralContent.trim(),
          attitudinal_content: form.attitudinalContent.trim(),
        })
        .eq('id', selected.id)
      if (error) throw error

      const nextRows = plans.map(row => row.id !== selected.id ? row : {
        ...row,
        title: form.title.trim(),
        desc: form.desc.trim(),
        status: form.status,
        weekStart: Number(form.weekStart),
        weekEnd: Number(form.weekEnd),
        hours: Number(form.hours),
        activities: Number(form.activities) || 0,
        domainRA: form.domainRA.trim(),
        elementCode: form.elementCode.trim(),
        elementTitle: form.elementTitle.trim(),
        domainEC: form.domainEC.trim(),
        learningActivities: form.learningActivities.trim(),
        activityPeriod: form.activityPeriod.trim(),
        evaluationActivities: form.evaluationActivities.trim(),
        evaluationInstruments: form.evaluationInstruments.trim(),
        conceptualContent: form.conceptualContent.trim(),
        proceduralContent: form.proceduralContent.trim(),
        attitudinalContent: form.attitudinalContent.trim(),
      })

      setPlans(nextRows)
      await createVersion(planId, nextRows, 'update')

      const { data: { user } } = await supabase.auth.getUser()
      await recordAuditEvent({
        user,
        module: 'Planificacion Anual',
        action: 'Actualizacion de RA institucional',
        details: `Se actualizo ${form.title.trim()} en el plan ${course} - ${year}`,
        type: 'planning',
      })

      // Clear local draft on successful save.
      try {
        if (typeof window !== 'undefined') window.localStorage.removeItem(draftKey('ra', String(selected?.id || '')))
      } catch {
        // ignore
      }

      setEditModal(false)
      showToast('success', 'RA actualizado correctamente')
    } catch (error) {
      console.error(error)
      showToast('error', `Error: ${error.message || 'No se pudo actualizar'}`)
    }
  }

  const cycleStatus = async (row) => {
    const cycle = { inactive: 'pending', pending: 'active', active: 'inactive' }
    const nextStatus = cycle[row.status]
    try {
      const { error } = await supabase.from('ra_items').update({ status: nextStatus }).eq('id', row.id)
      if (error) throw error
      const nextRows = plans.map(item => item.id === row.id ? { ...item, status: nextStatus } : item)
      setPlans(nextRows)
      await createVersion(planId, nextRows, 'update')
      showToast('success', `Estado: ${STATUS_MAP[nextStatus].label}`)
    } catch {
      showToast('error', 'Error al cambiar estado')
    }
  }

  const openDelete = (row) => {
    setSelected(row)
    setDeleteModal(true)
  }

  const handleDelete = async () => {
    try {
      const { error } = await supabase.from('ra_items').delete().eq('id', selected.id)
      if (error) throw error
      const nextRows = plans.filter(row => row.id !== selected.id)
      setPlans(nextRows)
      await createVersion(planId, nextRows, 'delete')

      const { data: { user } } = await supabase.auth.getUser()
      await recordAuditEvent({
        user,
        module: 'Planificacion Anual',
        action: 'Eliminacion de RA institucional',
        details: `Se elimino ${selected.title} del plan ${course} - ${year}`,
        type: 'planning',
      })

      setDeleteModal(false)
      showToast('success', 'RA eliminado')
    } catch {
      showToast('error', 'Error al eliminar el RA')
    }
  }

  const handleCopyPlan = async () => {
      setCopying(true)
    try {
      const sourceCourse = buildAcademicCourse(copyForm.subject, copyForm.section)
      const { data: sourcePlanRows, error: sourcePlanError } = await supabase
        .from('annual_plans')
        .select('*')
        .eq('course', sourceCourse)
        .eq('year', Number(copyForm.year))
        .order('created_at', { ascending: false, nullsFirst: false })
      if (sourcePlanError) throw sourcePlanError
      const sourcePlan = pickLatestRow(sourcePlanRows)
      if (!sourcePlan?.id) {
        showToast('warning', 'No existe un plan origen para copiar')
        return
      }

      const { data: sourceItems, error: sourceItemsError } = await supabase
        .from('ra_items')
        .select('*')
        .eq('plan_id', sourcePlan.id)
        .order('created_at', { ascending: true })
      if (sourceItemsError) throw sourceItemsError
      if (!sourceItems?.length) {
        showToast('warning', 'El plan origen no tiene RAs')
        return
      }

      const nextRows = mapRows(sourceItems)
      const copiedMeta = {
        ...normalizePlanMeta(sourcePlan, sourceCourse, Number(copyForm.year)),
        course,
        year,
      }

      const copied = await replacePlanState(nextRows, copiedMeta)
      if (!copied) throw new Error('No se pudo copiar el plan')

      await createVersion(planId, nextRows, 'copy', { course: sourceCourse, year: Number(copyForm.year) }, copiedMeta)

      const { data: { user } } = await supabase.auth.getUser()
      await recordAuditEvent({
        user,
        module: 'Planificacion Anual',
        action: 'Copia de plan institucional',
        details: `Se copio la planificacion de ${sourceCourse} (${copyForm.year}) hacia ${course} (${year})`,
        type: 'planning',
      })

      setCModal(false)
      showToast('success', 'Planificacion copiada correctamente')
    } catch (error) {
      console.error(error)
      showToast('error', 'Error al copiar la planificacion')
    } finally {
      setCopying(false)
    }
  }

  const saveMeta = async (nextMeta, options = {}) => {
    const { createSnapshot = true, closeModal = true, actionLabel = 'Datos generales actualizados', skipValidation = false } = options
    if (!skipValidation && !validateMeta(nextMeta)) return false

    setSavingMeta(true)
    try {
      const payload = {
        plan_kind: (nextMeta.plan_kind || 'tecnica').toLowerCase(),
        institution_name: nextMeta.institution_name.trim(),
        technical_degree: nextMeta.technical_degree.trim(),
        module_name: nextMeta.module_name.trim(),
        module_code: nextMeta.module_code ? nextMeta.module_code.trim() : null,
        teacher_name: nextMeta.teacher_name.trim(),
        uc_name: nextMeta.uc_name.trim(),
        uc_code: nextMeta.uc_code ? nextMeta.uc_code.trim() : null,
        start_date: nextMeta.start_date,
        end_date: nextMeta.end_date,
        hours_per_week: Number(nextMeta.hours_per_week),
        template_reference: nextMeta.template_reference || null,
      }

      const { error } = await supabase.from('annual_plans').update(payload).eq('id', planId)
      if (error) throw error

      setPlanMeta(nextMeta)
      setMetaForm(nextMeta)

      if (createSnapshot) {
        await createVersion(planId, plans, 'update', null, nextMeta)
      }

      const { data: { user } } = await supabase.auth.getUser()
      await recordAuditEvent({
        user,
        module: 'Planificacion Anual',
        action: actionLabel,
        details: `Se actualizaron los datos generales del plan ${course} - ${year}`,
        type: 'planning',
      })

      // Clear local draft on successful save.
      try {
        if (typeof window !== 'undefined') window.localStorage.removeItem(draftKey('meta'))
      } catch {
        // ignore
      }

      if (closeModal) setMetaModal(false)
      showToast('success', actionLabel)
      return true
    } catch (error) {
      console.error(error)
      showToast('error', 'Error al guardar los datos del plan')
      return false
    } finally {
      setSavingMeta(false)
    }
  }

  const applyTemplate = async (template, options = {}) => {
    const { openMeta = false, persistSelection = true } = options
    const nextMeta = mergePlanMetaWithTemplate({
      ...metaForm,
      course,
      year,
    }, template)

    setSelectedTemplateId(String(template.id))
    setMetaForm(nextMeta)
    setMetaErrors({})

      const saved = await saveMeta(nextMeta, {
        createSnapshot: true,
        closeModal: !openMeta,
        actionLabel: 'Plantilla institucional aplicada',
        skipValidation: true,
      })

    if (!saved) return

    if (persistSelection && typeof window !== 'undefined') {
      window.localStorage.removeItem('edunovaAnnualTemplateId')
    }

    if (openMeta) setMetaModal(true)
  }

  const completed = plans.filter(item => item.status === 'active').length
  const totalHours = plans.reduce((sum, item) => sum + item.hours, 0)
  const totalEC = plans.filter(item => item.elementCode || item.elementTitle).length
  const progress = plans.length ? Math.round((completed / plans.length) * 100) : 0

  const infoCards = [
    { label: 'Institucion', value: planMeta.institution_name || 'Sin definir', icon: 'fa-building' },
    { label: 'Modulo', value: planMeta.module_name || 'Sin definir', icon: 'fa-book' },
    { label: 'Codigo modulo', value: planMeta.module_code || 'Sin definir', icon: 'fa-hashtag' },
    { label: 'Docente', value: planMeta.teacher_name || 'Sin definir', icon: 'fa-user-tie' },
    { label: 'Unidad de competencia', value: planMeta.uc_code ? `${planMeta.uc_code} - ${planMeta.uc_name}` : 'Sin definir', icon: 'fa-link' },
    { label: 'Horas por semana', value: planMeta.hours_per_week ? `${planMeta.hours_per_week} h` : 'Sin definir', icon: 'fa-clock' },
  ]

  const exportMatrixPdf = async ({ download = true, audit = true, returnBlob = false } = {}) => {
    try {
      // Export institucional (formato tipo "matriz" del centro):
      // - Pagina vertical
      // - Encabezado centrado
      // - Un bloque por RA: titulo RA arriba + tabla EC/actividades/evaluacion/contenidos abajo
      const { data: { user } } = await supabase.auth.getUser()

      if (audit) {
        // Audit (non-critical): if audit table is blocked, the app still exports.
        try {
          await recordAuditEvent({
            user,
            module: 'Planificacion Anual',
            action: 'Exportar matriz (PDF)',
            details: `${course} - ${year}`,
            type: 'export',
          })
        } catch {
          // ignore
        }
      }

      const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' })
      const pageW = doc.internal.pageSize.getWidth()
      const pageH = doc.internal.pageSize.getHeight()
      const marginX = 36
      const contentW = pageW - marginX * 2

      const now = new Date()
      const safeKind = String(planMeta.plan_kind || 'tecnica').toLowerCase()
      const kindLabel = safeKind === 'academica' ? 'Academica' : 'Tecnica'
      const degreeLabel = safeKind === 'academica' ? 'Nivel / Modalidad' : 'Bachillerato tecnico'
      const moduleLabel = safeKind === 'academica' ? 'Asignatura' : 'Modulo formativo'
      const moduleCodeLabel = safeKind === 'academica' ? 'Codigo (opcional)' : 'Codigo del modulo'
      const ucLabel = safeKind === 'academica' ? 'Competencia / Objetivo' : 'Unidad de competencia'
      const ucCodeLabel = safeKind === 'academica' ? 'Codigo (opcional)' : 'Codigo UC'

      // Encabezado (con logo) - estilo institucional.
      // Logo real del MINERD (opcional).
      // Para activarlo: coloca el archivo en `frontend/public/minerd_logo.png`.
      // Si no existe, el PDF se genera igual, solo sin logo.
      let logoDataUrl = null
      let logoW = 0
      let logoH = 0

      try {
        const resp = await fetch('/minerd_logo.png', { cache: 'no-store' })
        if (!resp.ok) throw new Error('logo-not-found')
        const blob = await resp.blob()

        // Convertimos a dataURL sin deformar (y leemos el tamano real de la imagen).
        logoDataUrl = await new Promise((resolve) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result || ''))
          reader.onerror = () => resolve(null)
          reader.readAsDataURL(blob)
        })

        if (logoDataUrl) {
          await new Promise((resolve) => {
            const img = new Image()
            img.onload = () => {
              logoW = img.naturalWidth || img.width || 0
              logoH = img.naturalHeight || img.height || 0
              resolve(null)
            }
            img.onerror = () => resolve(null)
            img.src = logoDataUrl
          })
        }
      } catch {
        logoDataUrl = null
      }

      // Encabezado (similar al formato institucional del profesor):
      // - Logo pequeno arriba
      // - "Direccion General..." en negrita
      // - "Direccion de Educacion Tecnico Profesional" normal
      // - Institucion en negrita mas grande
      // - Titulos del documento
      let headerY = 34
      if (logoDataUrl && logoW > 0 && logoH > 0) {
        // El modelo del profesor usa el logo mas pequeno.
        const maxW = 120
        const maxH = 70
        const ratio = logoW / logoH
        let drawW = maxW
        let drawH = drawW / ratio
        if (drawH > maxH) {
          drawH = maxH
          drawW = drawH * ratio
        }
        const x = pageW / 2 - drawW / 2
        const y = 18
        doc.addImage(logoDataUrl, 'PNG', x, y, drawW, drawH)
        // More breathing room so the next line doesn't stick to the red "EDUCACION" inside the logo.
        headerY = y + drawH + 18
      } else {
        // Fallback si el logo no existe.
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(9)
        doc.setTextColor(15, 23, 42)
        doc.text('GOBIERNO DE LA REPUBLICA DOMINICANA', pageW / 2, headerY, { align: 'center' })
        headerY += 12
        doc.setTextColor(220, 38, 38)
        doc.text('EDUCACION', pageW / 2, headerY, { align: 'center' })
        headerY += 12
      }

      doc.setTextColor(15, 23, 42)
      // Keep the hierarchy close to the institutional model (no oversized headings).
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(9)
      doc.text('Direccion General de Educacion Secundaria', pageW / 2, headerY, { align: 'center' })
      headerY += 12

      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      doc.text('Direccion de Educacion Tecnico Profesional', pageW / 2, headerY, { align: 'center' })
      headerY += 14

      doc.setFont('helvetica', 'bold')
      doc.setFontSize(10)
      doc.text(sanitizeForPdf(planMeta.institution_name || 'INSTITUCION EDUCATIVA'), pageW / 2, headerY, { align: 'center' })
      headerY += 16

      doc.setFontSize(10)
      doc.text('PLANIFICACION ANUAL BAJO ENFOQUE POR COMPETENCIAS', pageW / 2, headerY, { align: 'center' })
      headerY += 14

      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
      doc.text(
        `MATRIZ DE PLANIFICACION POR RESULTADO DE APRENDIZAJE (RA) - ${kindLabel.toUpperCase()}`,
        pageW / 2,
        headerY,
        { align: 'center' },
      )
      headerY += 14

      // Linea separadora
      doc.setDrawColor(17, 24, 39)
      doc.setLineWidth(0.8)
      doc.line(marginX, headerY, pageW - marginX, headerY)
      headerY += 12

      // Bloque de datos generales (formato tipo ficha)
      const line1 = [
        `Curso: ${sanitizeForPdf(course)}`,
        `Ano: ${year}`,
        `${moduleLabel}: ${sanitizeForPdf(planMeta.module_name || 'Sin definir')}`,
        `${moduleCodeLabel}: ${sanitizeForPdf(planMeta.module_code || 'Sin definir')}`,
      ].join('   |   ')
      const line2 = [
        `Docente: ${sanitizeForPdf(planMeta.teacher_name || 'Sin definir')}`,
        `${ucCodeLabel}: ${sanitizeForPdf(planMeta.uc_code || 'Sin definir')}`,
        `${ucLabel}: ${sanitizeForPdf(planMeta.uc_name || 'Sin definir')}`,
      ].join('   |   ')

      doc.setTextColor(15, 23, 42)
      doc.setFontSize(8)
      const lineHeight = 10
      const line1Lines = doc.splitTextToSize(line1, contentW)
      doc.text(line1Lines, marginX, headerY)
      headerY += line1Lines.length * lineHeight

      const line2Lines = doc.splitTextToSize(line2, contentW)
      doc.text(line2Lines, marginX, headerY + 2)
      headerY += (line2Lines.length * lineHeight) + 6

      let cursorY = headerY + 8

      const borderColor = [0, 0, 0]
      const headerFill = [243, 244, 246]

      const ensureSpace = (neededHeight) => {
        if (cursorY + neededHeight < pageH - 36) return
        doc.addPage()
        cursorY = 54
      }

      // Un bloque por RA (se parece mas al formato del centro).
      const items = Array.isArray(plans) ? plans : []
      items.forEach((item, idx) => {
        ensureSpace(220)

        // Caja RA (titulo superior)
        const raLabel = `${item.code ? `${item.code}: ` : ''}${sanitizeForPdf(item.title || 'Resultado de aprendizaje')}`
        const raDesc = sanitizeForPdf(item.desc || '')
        const raWeeks = item.weekStart && item.weekEnd ? `Semanas ${item.weekStart}-${item.weekEnd}` : ''
        const raHours = item.hours ? `${item.hours} horas` : ''
        const raDomain = item.domainRA ? `Nivel de dominio RA: ${item.domainRA}` : 'Nivel de dominio RA: Sin definir'

        autoTable(doc, {
          startY: cursorY,
          theme: 'grid',
          styles: {
            fontSize: 8,
            cellPadding: 4,
            lineColor: borderColor,
            lineWidth: 1,
            valign: 'top',
            overflow: 'linebreak',
            textColor: [17, 24, 39],
          },
          headStyles: {
            fillColor: headerFill,
            textColor: [17, 24, 39],
            fontStyle: 'bold',
          },
          head: [[
            { content: 'RESULTADO DE APRENDIZAJE (RA)', colSpan: 2, styles: { fillColor: headerFill, fontStyle: 'bold' } },
          ]],
          body: [
            [
              { content: raLabel + (raDesc ? `\n${raDesc}` : ''), styles: { fontStyle: 'bold' } },
              { content: [raDomain, raWeeks, raHours].filter(Boolean).join('\n') },
            ],
          ],
          tableWidth: contentW,
          margin: { left: marginX, right: marginX },
          columnStyles: {
            0: { cellWidth: contentW * 0.68 },
            1: { cellWidth: contentW * 0.32 },
          },
        })

        cursorY = (doc.lastAutoTable?.finalY || cursorY) + 6

        // Tabla EC + actividades/evaluacion/contenidos (formato institucional)
        const ecText = item.elementCode || item.elementTitle
          ? `${item.elementCode || ''}${item.elementTitle ? ` - ${item.elementTitle}` : ''}`.trim()
          : 'Sin definir'

        const domEC = item.domainEC || 'Sin definir'

        const monthsOrPeriod = sanitizeForPdf(item.activityPeriod || '')
        const actividadesEA = sanitizeForPdf(item.learningActivities || '')
        const evaluacion = sanitizeForPdf(item.evaluationActivities || '')
        const instrumentos = sanitizeForPdf(item.evaluationInstruments || '')

        const contenidos = [
          `Conceptuales: ${sanitizeForPdf(item.conceptualContent || '')}`,
          `Procedimentales: ${sanitizeForPdf(item.proceduralContent || '')}`,
          `Actitudinales: ${sanitizeForPdf(item.attitudinalContent || '')}`,
        ].filter(Boolean).join('\n')

        autoTable(doc, {
          startY: cursorY,
          theme: 'grid',
          styles: {
            fontSize: 8,
            cellPadding: 4,
            lineColor: borderColor,
            lineWidth: 1,
            valign: 'top',
            overflow: 'linebreak',
            textColor: [17, 24, 39],
          },
          headStyles: {
            fillColor: headerFill,
            textColor: [17, 24, 39],
            fontStyle: 'bold',
          },
          head: [[
            { content: 'Elemento de Capacidad (EC)', styles: { fillColor: headerFill, fontStyle: 'bold' } },
            { content: 'Nivel de dominio (EC)', styles: { fillColor: headerFill, fontStyle: 'bold', halign: 'center' } },
            { content: 'Enunciado de las actividades E/A', styles: { fillColor: headerFill, fontStyle: 'bold' } },
            { content: 'Fecha / periodo', styles: { fillColor: headerFill, fontStyle: 'bold', halign: 'center' } },
            { content: 'Actividades e instrumentos de evaluacion', styles: { fillColor: headerFill, fontStyle: 'bold' } },
            { content: 'Contenidos a trabajar', styles: { fillColor: headerFill, fontStyle: 'bold' } },
          ]],
          body: [[
            ecText,
            domEC,
            actividadesEA || 'Sin definir',
            monthsOrPeriod || 'Sin definir',
            [evaluacion, instrumentos ? `Instrumentos: ${instrumentos}` : ''].filter(Boolean).join('\n') || 'Sin definir',
            contenidos || 'Sin definir',
          ]],
          tableWidth: contentW,
          margin: { left: marginX, right: marginX },
          columnStyles: {
            0: { cellWidth: contentW * 0.18 },
            1: { cellWidth: contentW * 0.10, halign: 'center' },
            2: { cellWidth: contentW * 0.20 },
            3: { cellWidth: contentW * 0.10, halign: 'center' },
            4: { cellWidth: contentW * 0.20 },
            5: { cellWidth: contentW * 0.22 },
          },
        })

        cursorY = (doc.lastAutoTable?.finalY || cursorY) + 14
        if (idx < items.length - 1) {
          // small separator space
          doc.setDrawColor(229, 231, 235)
          doc.line(marginX, cursorY - 8, pageW - marginX, cursorY - 8)
          doc.setDrawColor(0, 0, 0)
        }
      })

      // Footer page numbers
      const totalPages = doc.getNumberOfPages()
      for (let p = 1; p <= totalPages; p += 1) {
        doc.setPage(p)
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(8)
        doc.setTextColor(107, 114, 128)
        doc.text(`Pagina ${p} de ${totalPages}`, pageW - marginX, pageH - 18, { align: 'right' })
        doc.setTextColor(0, 0, 0)
      }

      const fileName = `matriz_${String(course).replace(/[^a-z0-9]+/gi, '_')}_${year}.pdf`

      // Some browsers/environments block the internal FileSaver flow used by `doc.save(...)`.
      // This explicit Blob download is more reliable.
      const blob = doc.output('blob')

      if (returnBlob) return { blob, fileName }

      if (download) {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = fileName
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
        showToast('success', 'PDF de la matriz descargado')
      }
    } catch (error) {
      console.error(error)
      showToast('error', 'Error al exportar PDF de la matriz')
    }
  }

  const sharePlanningByEmail = async () => {
    if (sendingShare) {
      showToast?.('warning', 'Ya se esta enviando la planificacion. Espera un momento...')
      return
    }

    setSendingShare(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        showToast?.('error', 'Debes iniciar sesion para compartir la planificacion')
        return
      }

      showToast?.('info', 'Enviando planificacion... (puede tardar unos segundos)')

      const built = await exportMatrixPdf({ download: false, audit: false, returnBlob: true })
      if (!built?.blob) return
      const pdfBase64 = arrayBufferToBase64(await built.blob.arrayBuffer())

      const { data: profileRow } = await supabase
        .from('profiles')
        .select('full_name, email')
        .eq('id', user.id)
        .maybeSingle()

      const sharedByName = profileRow?.full_name || user?.user_metadata?.full_name || user?.email || 'Docente'
      const sharedByEmail = profileRow?.email || user?.email || ''

      const firstRa = plans?.[0] || {}

      const res = await planningShareService.shareAnnualPlanningPdf({
        plan_type: 'annual',
        subject,
        course,
        year,
        plan_kind: planMeta?.plan_kind || 'Tecnica',
        module_name: planMeta?.module_name || '',
        module_code: planMeta?.module_code || '',
        uc_code: planMeta?.uc_code || '',
        uc_title: planMeta?.uc_name || '',
        ra_title: firstRa.title || '',
        ra_domain: firstRa.domain_level || '',
        shared_by_name: sharedByName,
        shared_by_email: sharedByEmail || null,
        app_link: window.location.href,
        pdf_base64: pdfBase64,
        filename: built.fileName,
      })

      if (!res?.data?.ok) {
        throw new Error(res?.data?.message || 'No se pudo enviar la planificacion por correo')
      }

      showToast?.('success', res?.data?.message || 'Planificacion (PDF) enviada al Director/Coordinador por correo')
    } catch (error) {
      console.error(error)
      const msg = String(error?.response?.data?.detail || error?.message || '')
      showToast?.('error', msg || 'No se pudo enviar la planificacion por correo')
    } finally {
      setSendingShare(false)
    }
  }


  return (
    <section>
      <div className="page-header">
        <div className="breadcrumb"><a onClick={() => onNavigate('dashboard')}>Inicio</a><span>/</span><span>Planificacion Anual</span></div>
        <h2>Planificacion Anual - Matriz Institucional</h2>
        <p>Organiza datos generales del plan, resultados de aprendizaje, elementos de capacidad, evaluacion y contenidos segun el formato institucional.</p>
      </div>

      <div className="stats-grid">
        {[
          { i: 'fa-sitemap', c: 'blue', v: plans.length, l: 'Total RAs' },
          { i: 'fa-project-diagram', c: 'purple', v: totalEC, l: 'Elementos de capacidad' },
          { i: 'fa-check-circle', c: 'green', v: completed, l: 'Completados' },
          { i: 'fa-clock', c: 'orange', v: totalHours, l: 'Horas planificadas' },
        ].map(item => (
          <div className="stat-card" key={item.l}>
            <div className={`icon ${item.c}`}><i className={`fas ${item.i}`} /></div>
            <div className="value">{item.v}</div>
            <div className="label">{item.l}</div>
          </div>
        ))}
      </div>

      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <div className="card-body" style={{ padding: '1rem 1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
            <span style={{ fontWeight: 600 }}>Progreso de la matriz institucional</span>
            <span style={{ fontWeight: 700, color: 'var(--primary)' }}>{progress}%</span>
          </div>
          <div className="progress-bar"><div className="fill green" style={{ width: `${progress}%`, transition: 'width .4s' }} /></div>
          <p style={{ fontSize: '0.8rem', color: '#6b7280', marginTop: '0.4rem' }}>{completed} de {plans.length} RAs completados</p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <div className="card-header">
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
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
            <select className="form-control" style={{ width: 'auto' }} value={year} onChange={e => setYear(Number(e.target.value))}>
              {YEARS.map(option => <option key={option} value={option}>Ano {option}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" onClick={() => setMetaModal(true)}><i className="fas fa-file-lines" />Datos generales</button>
            <button className="btn btn-secondary" onClick={() => setTemplateModal(true)}><i className="fas fa-layer-group" />Aplicar plantilla</button>
            <button className="btn btn-secondary" onClick={() => setCModal(true)}><i className="fas fa-copy" />Copiar periodo</button>
            <button className="btn btn-secondary" onClick={() => setVModal(true)}><i className="fas fa-history" />Versiones</button>
            <button
              className="btn btn-secondary"
              onClick={sharePlanningByEmail}
              disabled={sendingShare}
              title="Enviar esta planificacion por correo al Director/Coordinador"
              style={sendingShare ? { opacity: 0.7, cursor: 'not-allowed' } : undefined}
            >
              <i className={`fas ${sendingShare ? 'fa-spinner fa-spin' : 'fa-paper-plane'}`} />
              {sendingShare ? 'Enviando...' : 'Enviar al Director'}
            </button>
            <button className="btn btn-secondary" onClick={exportMatrixPdf} title="Descargar matriz institucional en PDF">
              <i className="fas fa-file-pdf" />Exportar PDF
            </button>
            <button className="btn btn-primary" onClick={openAdd}><i className="fas fa-plus" />Agregar RA</button>
          </div>
        </div>
        <div className="card-body">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <div>
              <p style={{ fontWeight: 700, fontSize: '1rem' }}>{course} - {year}</p>
              <p style={{ fontSize: '0.84rem', color: '#6b7280' }}>
                Plantilla activa: <strong>{planMeta.template_reference || 'Matriz institucional base'}</strong>
              </p>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <span className="status-badge pending">{planMeta.module_code || 'Modulo sin codigo'}</span>
              <span className="status-badge active">{planMeta.uc_code || 'UC sin codigo'}</span>
              <span className="status-badge inactive">
                {planMeta.start_date && planMeta.end_date ? `${planMeta.start_date} al ${planMeta.end_date}` : 'Fechas no definidas'}
              </span>
            </div>
          </div>

          <div className="grid-3" style={{ marginBottom: '1rem' }}>
            {infoCards.map(card => (
              <div key={card.label} style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 12, padding: '0.9rem 1rem' }}>
                <p style={{ fontSize: '0.72rem', color: '#9ca3af', marginBottom: 4 }}>
                  <i className={`fas ${card.icon}`} style={{ marginRight: 6 }} />
                  {card.label.toUpperCase()}
                </p>
                <p style={{ fontWeight: 600, color: '#111827' }}>{card.value}</p>
              </div>
            ))}
          </div>

          <div style={{ background: 'rgba(37,99,235,0.05)', border: '1px solid rgba(37,99,235,0.15)', borderRadius: 12, padding: '1rem' }}>
            <p style={{ fontWeight: 700, marginBottom: '0.45rem' }}>Estructura institucional de la planificacion</p>
            <p style={{ fontSize: '0.84rem', color: '#6b7280', marginBottom: '0.75rem' }}>{activeStructure.overview}</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.45rem' }}>
              {activeStructure.sections.flatMap(section => section.items).map(item => (
                <span key={item} className="status-badge pending">{item}</span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-body">
          {loading ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: '#6b7280' }}>
              <i className="fas fa-spinner fa-spin" style={{ fontSize: '1.5rem', marginBottom: '0.5rem', display: 'block' }} />
              Cargando matriz institucional...
            </div>
          ) : plans.length === 0 ? (
            <div className="empty-state">
              <i className="fas fa-sitemap" />
              <h3>No hay resultados de aprendizaje en esta matriz</h3>
              <p>Agrega el primer RA o aplica una plantilla institucional y completa los datos generales del plan.</p>
              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
                <button className="btn btn-secondary" onClick={() => setTemplateModal(true)}><i className="fas fa-layer-group" />Aplicar plantilla</button>
                <button className="btn btn-primary" onClick={openAdd}><i className="fas fa-plus" />Agregar RA</button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: '1rem' }}>
              {plans.map(item => {
                const status = STATUS_MAP[item.status]
                return (
                  <div className="competency-item" key={item.id}>
                    <div className="header">
                      <div>
                        <h4 style={{ cursor: 'pointer' }} title="Clic para cambiar estado" onClick={() => cycleStatus(item)}>
                          <i className={`fas ${status.icon}`} style={{ color: status.color }} /> {item.title}
                        </h4>
                        <p style={{ fontSize: '0.82rem', color: '#6b7280', marginTop: 4 }}>{item.code} - {item.elementCode || 'EC pendiente'} / {item.elementTitle || 'Elemento sin titulo'}</p>
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        <span className="code">{item.code}</span>
                        <span className={`status-badge ${status.cls}`}>{status.label}</span>
                      </div>
                    </div>

                    <p style={{ color: '#4b5563', marginBottom: '0.75rem', fontSize: '0.875rem' }}>{item.desc}</p>

                    <div className="grid-3" style={{ marginBottom: '0.9rem' }}>
                      <div style={{ background: '#f8fafc', borderRadius: 10, padding: '0.8rem', border: '1px solid #e5e7eb' }}>
                        <p style={{ fontSize: '0.72rem', color: '#9ca3af', marginBottom: 4 }}>DOMINIO RA / EC</p>
                        <p style={{ fontWeight: 600 }}>{item.domainRA || 'Sin definir'} / {item.domainEC || 'Sin definir'}</p>
                      </div>
                      <div style={{ background: '#f8fafc', borderRadius: 10, padding: '0.8rem', border: '1px solid #e5e7eb' }}>
                        <p style={{ fontSize: '0.72rem', color: '#9ca3af', marginBottom: 4 }}>PERIODO Y SEMANAS</p>
                        <p style={{ fontWeight: 600 }}>{item.activityPeriod || 'Sin definir'} - Semanas {item.weekStart}-{item.weekEnd}</p>
                      </div>
                      <div style={{ background: '#f8fafc', borderRadius: 10, padding: '0.8rem', border: '1px solid #e5e7eb' }}>
                        <p style={{ fontSize: '0.72rem', color: '#9ca3af', marginBottom: 4 }}>CARGA DE TRABAJO</p>
                        <p style={{ fontWeight: 600 }}>{item.hours} horas / {item.activities} actividades</p>
                      </div>
                    </div>

                    <div className="grid-3" style={{ marginBottom: '0.9rem' }}>
                      <div style={{ background: '#fff', borderRadius: 10, padding: '0.8rem', border: '1px solid #e5e7eb' }}>
                        <p style={{ fontSize: '0.72rem', color: '#9ca3af', marginBottom: 4 }}>ACTIVIDADES E/A</p>
                        <p style={{ fontSize: '0.83rem', color: '#374151', whiteSpace: 'pre-line' }}>{item.learningActivities || 'Sin definir'}</p>
                      </div>
                      <div style={{ background: '#fff', borderRadius: 10, padding: '0.8rem', border: '1px solid #e5e7eb' }}>
                        <p style={{ fontSize: '0.72rem', color: '#9ca3af', marginBottom: 4 }}>EVALUACION</p>
                        <p style={{ fontSize: '0.83rem', color: '#374151', whiteSpace: 'pre-line' }}>{buildActivitySummary(item) || 'Sin definir'}</p>
                      </div>
                      <div style={{ background: '#fff', borderRadius: 10, padding: '0.8rem', border: '1px solid #e5e7eb' }}>
                        <p style={{ fontSize: '0.72rem', color: '#9ca3af', marginBottom: 4 }}>CONTENIDOS</p>
                        <p style={{ fontSize: '0.83rem', color: '#374151', whiteSpace: 'pre-line' }}>
                          C: {item.conceptualContent || 'Sin definir'}{'\n'}
                          P: {item.proceduralContent || 'Sin definir'}{'\n'}
                          A: {item.attitudinalContent || 'Sin definir'}
                        </p>
                      </div>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                      <div className="progress-bar" style={{ flex: 1, minWidth: 180, height: 7 }}>
                        <div
                          className={`fill ${item.status === 'active' ? 'green' : item.status === 'pending' ? 'blue' : ''}`}
                          style={{ width: item.status === 'active' ? '100%' : item.status === 'pending' ? '50%' : '10%' }}
                        />
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button className="btn btn-sm btn-secondary" onClick={() => { setSelected(item); setViewModal(true) }}><i className="fas fa-eye" /></button>
                        <button className="btn btn-sm btn-secondary" onClick={() => openEdit(item)}><i className="fas fa-edit" /></button>
                        <button className="btn btn-sm btn-secondary" style={{ color: 'var(--danger)' }} onClick={() => openDelete(item)}><i className="fas fa-trash" /></button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {(addModal || editModal) && (
        <Modal
          title={addModal ? 'Agregar Resultado de Aprendizaje' : 'Editar Resultado de Aprendizaje'}
          icon={addModal ? 'fa-plus-circle' : 'fa-edit'}
          iconColor={addModal ? 'var(--success)' : 'var(--warning)'}
          onClose={() => { setAddModal(false); setEditModal(false) }}
          maxWidth="980px"
          footer={<>
            <button className="btn btn-secondary" onClick={() => { setAddModal(false); setEditModal(false) }}>Cancelar</button>
            <button className="btn btn-primary" onClick={addModal ? handleAdd : handleEdit}>
              <i className="fas fa-save" />{addModal ? 'Guardar RA' : 'Actualizar RA'}
            </button>
          </>}
        >
          <div className="alert-card success" style={{ marginBottom: '1rem' }}>
            <i className="fas fa-circle-info icon" />
            <div>
              <strong>Matriz institucional</strong>
              <p style={{ fontSize: '0.82rem' }}>
                Completa el RA, el elemento de capacidad, las actividades, la evaluacion y los contenidos para que la planificacion quede alineada con el formato del centro.
              </p>
            </div>
          </div>

          <div className="grid-2">
            <div className="form-group">
              <label>Titulo del RA *</label>
              <input className="form-control" placeholder="Ej: Disenar bases de datos relacionales..." value={form.title} onChange={e => setF('title', e.target.value)} />
              {errors.title && <small style={{ color: 'var(--danger)' }}>{errors.title}</small>}
            </div>
            <div className="form-group">
              <label>Nivel de dominio del RA *</label>
              <input className="form-control" placeholder="Ej: Aplica con autonomia" value={form.domainRA} onChange={e => setF('domainRA', e.target.value)} />
              {errors.domainRA && <small style={{ color: 'var(--danger)' }}>{errors.domainRA}</small>}
            </div>
          </div>

          <div className="form-group">
            <label>Descripcion / Indicador general *</label>
            <textarea className="form-control" rows={3} placeholder="Describe el resultado de aprendizaje esperado" value={form.desc} onChange={e => setF('desc', e.target.value)} />
            {errors.desc && <small style={{ color: 'var(--danger)' }}>{errors.desc}</small>}
          </div>

          <div className="grid-2">
            <div className="form-group">
              <label>Codigo del EC *</label>
              <input className="form-control" placeholder="Ej: EC 4.1.1" value={form.elementCode} onChange={e => setF('elementCode', e.target.value)} />
              {errors.elementCode && <small style={{ color: 'var(--danger)' }}>{errors.elementCode}</small>}
            </div>
            <div className="form-group">
              <label>Nivel de dominio del EC *</label>
              <input className="form-control" placeholder="Ej: Ejecuta con precision" value={form.domainEC} onChange={e => setF('domainEC', e.target.value)} />
              {errors.domainEC && <small style={{ color: 'var(--danger)' }}>{errors.domainEC}</small>}
            </div>
          </div>

          <div className="form-group">
            <label>Titulo del EC *</label>
            <input className="form-control" placeholder="Ej: Modelar la estructura de la base de datos segun el caso propuesto" value={form.elementTitle} onChange={e => setF('elementTitle', e.target.value)} />
            {errors.elementTitle && <small style={{ color: 'var(--danger)' }}>{errors.elementTitle}</small>}
          </div>

          <div className="grid-2">
            <div className="form-group">
              <label>Periodo / fecha de realizacion *</label>
              <input className="form-control" placeholder="Ej: Agosto - Septiembre" value={form.activityPeriod} onChange={e => setF('activityPeriod', e.target.value)} />
              {errors.activityPeriod && <small style={{ color: 'var(--danger)' }}>{errors.activityPeriod}</small>}
            </div>
            <div className="form-group">
              <label>Estado</label>
              <select className="form-control" value={form.status} onChange={e => setF('status', e.target.value)}>
                <option value="inactive">Pendiente</option>
                <option value="pending">En progreso</option>
                <option value="active">Completado</option>
              </select>
            </div>
          </div>

          <div className="grid-2">
            <div className="form-group">
              <label>Semana inicio *</label>
              <input type="number" className="form-control" min="1" max="40" value={form.weekStart} onChange={e => setF('weekStart', e.target.value)} />
              {errors.weekStart && <small style={{ color: 'var(--danger)' }}>{errors.weekStart}</small>}
            </div>
            <div className="form-group">
              <label>Semana fin *</label>
              <input type="number" className="form-control" min="1" max="40" value={form.weekEnd} onChange={e => setF('weekEnd', e.target.value)} />
              {errors.weekEnd && <small style={{ color: 'var(--danger)' }}>{errors.weekEnd}</small>}
            </div>
            <div className="form-group">
              <label>Horas totales *</label>
              <input type="number" className="form-control" min="1" value={form.hours} onChange={e => setF('hours', e.target.value)} />
              {errors.hours && <small style={{ color: 'var(--danger)' }}>{errors.hours}</small>}
            </div>
            <div className="form-group">
              <label>No actividades</label>
              <input type="number" className="form-control" min="0" value={form.activities} onChange={e => setF('activities', e.target.value)} />
            </div>
          </div>

          <div className="form-group">
            <label>Actividades de ensenanza / aprendizaje *</label>
            <textarea
              className="form-control"
              rows={3}
              placeholder={getHint(activeStructure, 'learningActivities', 'Describe practicas, investigaciones, demostraciones o ejercicios guiados')}
              value={form.learningActivities}
              onChange={e => setF('learningActivities', e.target.value)}
            />
            {errors.learningActivities && <small style={{ color: 'var(--danger)' }}>{errors.learningActivities}</small>}
          </div>

          <div className="grid-2">
            <div className="form-group">
              <label>Actividades de evaluacion *</label>
              <textarea
                className="form-control"
                rows={3}
                placeholder={getHint(activeStructure, 'evaluationActivities', 'Ej: estudio de casos, proyecto, practica supervisada')}
                value={form.evaluationActivities}
                onChange={e => setF('evaluationActivities', e.target.value)}
              />
              {errors.evaluationActivities && <small style={{ color: 'var(--danger)' }}>{errors.evaluationActivities}</small>}
            </div>
            <div className="form-group">
              <label>Instrumentos de evaluacion *</label>
              <textarea
                className="form-control"
                rows={3}
                placeholder={getHint(activeStructure, 'evaluationInstruments', 'Ej: rubrica, lista de cotejo, portafolio, observacion')}
                value={form.evaluationInstruments}
                onChange={e => setF('evaluationInstruments', e.target.value)}
              />
              {errors.evaluationInstruments && <small style={{ color: 'var(--danger)' }}>{errors.evaluationInstruments}</small>}
            </div>
          </div>

          <div className="grid-3">
            <div className="form-group">
              <label>Contenidos conceptuales *</label>
              <textarea
                className="form-control"
                rows={4}
                placeholder={getHint(activeStructure, 'conceptualContent', 'Conceptos, definiciones y teoria')}
                value={form.conceptualContent}
                onChange={e => setF('conceptualContent', e.target.value)}
              />
              {errors.conceptualContent && <small style={{ color: 'var(--danger)' }}>{errors.conceptualContent}</small>}
            </div>
            <div className="form-group">
              <label>Contenidos procedimentales *</label>
              <textarea
                className="form-control"
                rows={4}
                placeholder={getHint(activeStructure, 'proceduralContent', 'Procesos, tecnicas o pasos')}
                value={form.proceduralContent}
                onChange={e => setF('proceduralContent', e.target.value)}
              />
              {errors.proceduralContent && <small style={{ color: 'var(--danger)' }}>{errors.proceduralContent}</small>}
            </div>
            <div className="form-group">
              <label>Contenidos actitudinales *</label>
              <textarea
                className="form-control"
                rows={4}
                placeholder={getHint(activeStructure, 'attitudinalContent', 'Valores, actitudes y disposicion')}
                value={form.attitudinalContent}
                onChange={e => setF('attitudinalContent', e.target.value)}
              />
              {errors.attitudinalContent && <small style={{ color: 'var(--danger)' }}>{errors.attitudinalContent}</small>}
            </div>
          </div>
        </Modal>
      )}

      {metaModal && (
        <Modal
          title="Datos generales del plan institucional"
          icon="fa-file-lines"
          onClose={() => setMetaModal(false)}
          maxWidth="940px"
          footer={<>
            <button className="btn btn-secondary" onClick={() => setMetaModal(false)}>Cancelar</button>
            <button className="btn btn-primary" onClick={() => saveMeta(metaForm)} disabled={savingMeta}>
              <i className={`fas ${savingMeta ? 'fa-spinner fa-spin' : 'fa-save'}`} />Guardar datos generales
            </button>
          </>}
        >
          <div className="grid-2">
            <div className="form-group">
              <label>Institucion *</label>
              <input className="form-control" value={metaForm.institution_name} onChange={e => setMF('institution_name', e.target.value)} />
              {metaErrors.institution_name && <small style={{ color: 'var(--danger)' }}>{metaErrors.institution_name}</small>}
            </div>
            <div className="form-group">
              <label>Tipo de planificacion *</label>
              <select className="form-control" value={metaForm.plan_kind || 'tecnica'} onChange={e => setMF('plan_kind', e.target.value)}>
                <option value="tecnica">Tecnica</option>
                <option value="academica">Academica</option>
              </select>
            </div>
            <div className="form-group">
              <label>{String(metaForm.plan_kind || 'tecnica').toLowerCase() === 'academica' ? 'Nivel / Modalidad *' : 'Bachillerato tecnico *'}</label>
              <input className="form-control" value={metaForm.technical_degree} onChange={e => setMF('technical_degree', e.target.value)} />
              {metaErrors.technical_degree && <small style={{ color: 'var(--danger)' }}>{metaErrors.technical_degree}</small>}
            </div>
            <div className="form-group">
              <label>{String(metaForm.plan_kind || 'tecnica').toLowerCase() === 'academica' ? 'Asignatura *' : 'Modulo formativo *'}</label>
              <input className="form-control" value={metaForm.module_name} onChange={e => setMF('module_name', e.target.value)} />
              {metaErrors.module_name && <small style={{ color: 'var(--danger)' }}>{metaErrors.module_name}</small>}
            </div>
            <div className="form-group">
              <label>{String(metaForm.plan_kind || 'tecnica').toLowerCase() === 'academica' ? 'Codigo (opcional)' : 'Codigo del modulo *'}</label>
              <input className="form-control" value={metaForm.module_code} onChange={e => setMF('module_code', e.target.value)} />
              {metaErrors.module_code && <small style={{ color: 'var(--danger)' }}>{metaErrors.module_code}</small>}
            </div>
            <div className="form-group">
              <label>Docente *</label>
              <input className="form-control" value={metaForm.teacher_name} onChange={e => setMF('teacher_name', e.target.value)} />
              {metaErrors.teacher_name && <small style={{ color: 'var(--danger)' }}>{metaErrors.teacher_name}</small>}
            </div>
            <div className="form-group">
              <label>Horas por semana *</label>
              <input type="number" className="form-control" min="1" value={metaForm.hours_per_week} onChange={e => setMF('hours_per_week', e.target.value)} />
              {metaErrors.hours_per_week && <small style={{ color: 'var(--danger)' }}>{metaErrors.hours_per_week}</small>}
            </div>
            <div className="form-group">
              <label>{String(metaForm.plan_kind || 'tecnica').toLowerCase() === 'academica' ? 'Competencia / Objetivo *' : 'Unidad de competencia *'}</label>
              <textarea className="form-control" rows={3} value={metaForm.uc_name} onChange={e => setMF('uc_name', e.target.value)} />
              {metaErrors.uc_name && <small style={{ color: 'var(--danger)' }}>{metaErrors.uc_name}</small>}
            </div>
            <div className="form-group">
              <label>{String(metaForm.plan_kind || 'tecnica').toLowerCase() === 'academica' ? 'Codigo (opcional)' : 'Codigo UC *'}</label>
              <input className="form-control" value={metaForm.uc_code} onChange={e => setMF('uc_code', e.target.value)} />
              {metaErrors.uc_code && <small style={{ color: 'var(--danger)' }}>{metaErrors.uc_code}</small>}
            </div>
            <div className="form-group">
              <label>Fecha de inicio *</label>
              <input type="date" className="form-control" value={metaForm.start_date} onChange={e => setMF('start_date', e.target.value)} />
              {metaErrors.start_date && <small style={{ color: 'var(--danger)' }}>{metaErrors.start_date}</small>}
            </div>
            <div className="form-group">
              <label>Fecha de termino *</label>
              <input type="date" className="form-control" value={metaForm.end_date} onChange={e => setMF('end_date', e.target.value)} />
              {metaErrors.end_date && <small style={{ color: 'var(--danger)' }}>{metaErrors.end_date}</small>}
            </div>
            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label>Plantilla institucional aplicada</label>
              <input className="form-control" value={metaForm.template_reference || 'Matriz institucional base'} onChange={e => setMF('template_reference', e.target.value)} />
            </div>
          </div>
        </Modal>
      )}

      {templateModal && (
        <Modal
          title="Aplicar plantilla institucional"
          icon="fa-layer-group"
          onClose={() => setTemplateModal(false)}
          maxWidth="920px"
          footer={<>
            <button className="btn btn-secondary" onClick={() => setTemplateModal(false)}>Cerrar</button>
            <button
              className="btn btn-primary"
              onClick={() => {
                const template = templates.find(item => String(item.id) === String(selectedTemplateId))
                if (!template) {
                  showToast('warning', 'Selecciona una plantilla')
                  return
                }
                setTemplateModal(false)
                applyTemplate(template, { openMeta: true })
              }}
              disabled={templateLoading || templates.length === 0}
            >
              <i className="fas fa-check" />Aplicar y completar datos
            </button>
          </>}
        >
          {templateLoading ? (
            <div style={{ textAlign: 'center', padding: '2rem', color: '#6b7280' }}>
              <i className="fas fa-spinner fa-spin" style={{ marginRight: 8 }} />Cargando plantillas institucionales...
            </div>
          ) : templates.length === 0 ? (
            <div className="empty-state" style={{ padding: '1rem' }}>
              <i className="fas fa-layer-group" />
              <h3>No hay plantillas institucionales</h3>
              <p>Primero crea o carga una plantilla institucional en el apartado Plantillas.</p>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: '1rem' }}>
              {templates.map(template => (
                <div
                  key={template.id}
                  onClick={() => setSelectedTemplateId(String(template.id))}
                  style={{
                    borderRadius: 14,
                    padding: '1rem 1.1rem',
                    border: String(template.id) === String(selectedTemplateId)
                      ? `2px solid ${template.c || 'var(--primary)'}`
                      : '1px solid #e5e7eb',
                    background: String(template.id) === String(selectedTemplateId)
                      ? 'rgba(37,99,235,0.05)'
                      : '#fff',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}>
                    <div>
                      <p style={{ fontWeight: 700 }}>
                        <i className={`fas ${template.i}`} style={{ color: template.c, marginRight: 8 }} />
                        {template.n}
                      </p>
                      <p style={{ fontSize: '0.83rem', color: '#6b7280' }}>{template.d}</p>
                    </div>
                    <span className="status-badge pending">{template.isSystem ? 'Sistema' : 'Personalizada'}</span>
                  </div>
                  <p style={{ fontSize: '0.83rem', color: '#4b5563', marginBottom: '0.75rem' }}>{template.content}</p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.45rem' }}>
                    {(template.structure?.sections || []).flatMap(section => section.items).map(item => (
                      <span key={`${template.id}-${item}`} className="status-badge active">{item}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}

      {viewModal && selected && (
        <Modal
          title="Detalle del RA institucional"
          icon="fa-eye"
          iconColor="var(--secondary)"
          onClose={() => setViewModal(false)}
          maxWidth="980px"
          footer={<>
            <button className="btn btn-secondary" onClick={() => setViewModal(false)}>Cerrar</button>
            <button className="btn btn-primary" onClick={() => { setViewModal(false); openEdit(selected) }}><i className="fas fa-edit" />Editar</button>
          </>}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <div>
              <span className="code">{selected.code}</span>
              <h3 style={{ fontSize: '1.05rem', marginTop: '0.5rem' }}>{selected.title}</h3>
              <p style={{ fontSize: '0.86rem', color: '#6b7280' }}>{selected.desc}</p>
            </div>
            <span className={`status-badge ${STATUS_MAP[selected.status].cls}`}>{STATUS_MAP[selected.status].label}</span>
          </div>

          <div className="grid-3" style={{ marginBottom: '1rem' }}>
            <div style={{ background: '#f3f4f6', padding: '0.8rem', borderRadius: 10 }}>
              <p style={{ fontSize: '0.72rem', color: '#9ca3af', marginBottom: 4 }}>DOMINIO RA</p>
              <p style={{ fontWeight: 600 }}>{selected.domainRA || 'Sin definir'}</p>
            </div>
            <div style={{ background: '#f3f4f6', padding: '0.8rem', borderRadius: 10 }}>
              <p style={{ fontSize: '0.72rem', color: '#9ca3af', marginBottom: 4 }}>EC</p>
              <p style={{ fontWeight: 600 }}>{selected.elementCode || 'Sin codigo'} - {selected.elementTitle || 'Sin titulo'}</p>
            </div>
            <div style={{ background: '#f3f4f6', padding: '0.8rem', borderRadius: 10 }}>
              <p style={{ fontSize: '0.72rem', color: '#9ca3af', marginBottom: 4 }}>DOMINIO EC</p>
              <p style={{ fontWeight: 600 }}>{selected.domainEC || 'Sin definir'}</p>
            </div>
            <div style={{ background: '#f3f4f6', padding: '0.8rem', borderRadius: 10 }}>
              <p style={{ fontSize: '0.72rem', color: '#9ca3af', marginBottom: 4 }}>PERIODO</p>
              <p style={{ fontWeight: 600 }}>{selected.activityPeriod || 'Sin definir'}</p>
            </div>
            <div style={{ background: '#f3f4f6', padding: '0.8rem', borderRadius: 10 }}>
              <p style={{ fontSize: '0.72rem', color: '#9ca3af', marginBottom: 4 }}>SEMANAS</p>
              <p style={{ fontWeight: 600 }}>{selected.weekStart} - {selected.weekEnd}</p>
            </div>
            <div style={{ background: '#f3f4f6', padding: '0.8rem', borderRadius: 10 }}>
              <p style={{ fontSize: '0.72rem', color: '#9ca3af', marginBottom: 4 }}>HORAS / ACTIVIDADES</p>
              <p style={{ fontWeight: 600 }}>{selected.hours} h / {selected.activities} actividades</p>
            </div>
          </div>

          <div className="grid-2">
            <div className="form-group">
              <label>Actividades de ensenanza / aprendizaje</label>
              <div style={{ background: '#f8fafc', borderRadius: 10, padding: '0.9rem', border: '1px solid #e5e7eb', whiteSpace: 'pre-line', fontSize: '0.84rem' }}>{selected.learningActivities}</div>
            </div>
            <div className="form-group">
              <label>Actividades de evaluacion</label>
              <div style={{ background: '#f8fafc', borderRadius: 10, padding: '0.9rem', border: '1px solid #e5e7eb', whiteSpace: 'pre-line', fontSize: '0.84rem' }}>{selected.evaluationActivities}</div>
            </div>
            <div className="form-group">
              <label>Instrumentos de evaluacion</label>
              <div style={{ background: '#f8fafc', borderRadius: 10, padding: '0.9rem', border: '1px solid #e5e7eb', whiteSpace: 'pre-line', fontSize: '0.84rem' }}>{selected.evaluationInstruments}</div>
            </div>
          </div>

          <div className="grid-3">
            <div className="form-group">
              <label>Contenidos conceptuales</label>
              <div style={{ background: '#f8fafc', borderRadius: 10, padding: '0.9rem', border: '1px solid #e5e7eb', whiteSpace: 'pre-line', fontSize: '0.84rem' }}>{selected.conceptualContent}</div>
            </div>
            <div className="form-group">
              <label>Contenidos procedimentales</label>
              <div style={{ background: '#f8fafc', borderRadius: 10, padding: '0.9rem', border: '1px solid #e5e7eb', whiteSpace: 'pre-line', fontSize: '0.84rem' }}>{selected.proceduralContent}</div>
            </div>
            <div className="form-group">
              <label>Contenidos actitudinales</label>
              <div style={{ background: '#f8fafc', borderRadius: 10, padding: '0.9rem', border: '1px solid #e5e7eb', whiteSpace: 'pre-line', fontSize: '0.84rem' }}>{selected.attitudinalContent}</div>
            </div>
          </div>
        </Modal>
      )}

      {deleteModal && selected && (
        <Modal
          title="Eliminar RA institucional"
          icon="fa-trash"
          iconColor="var(--danger)"
          onClose={() => setDeleteModal(false)}
          maxWidth="480px"
          footer={<>
            <button className="btn btn-secondary" onClick={() => setDeleteModal(false)}>Cancelar</button>
            <button className="btn btn-danger" onClick={handleDelete}><i className="fas fa-trash" />Eliminar</button>
          </>}
        >
          <p>Seguro que deseas eliminar este resultado de aprendizaje institucional?</p>
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '0.875rem', marginTop: '0.75rem' }}>
            <p style={{ fontWeight: 600 }}>{selected.title}</p>
            <p style={{ fontSize: '0.82rem', color: '#6b7280' }}>{selected.code} - {selected.elementCode}</p>
          </div>
          <p style={{ color: 'var(--danger)', fontSize: '0.82rem', marginTop: '0.75rem' }}>
            <i className="fas fa-exclamation-circle" style={{ marginRight: 5 }} />Esta accion no se puede deshacer.
          </p>
        </Modal>
      )}

      {vModal && (
        <Modal
          title="Historial de Versiones"
          icon="fa-history"
          iconColor="var(--secondary)"
          onClose={() => setVModal(false)}
          maxWidth="900px"
          footer={<button className="btn btn-secondary" onClick={() => setVModal(false)}>Cerrar</button>}
        >
          <p style={{ color: '#6b7280', fontSize: '0.85rem', marginBottom: '1rem' }}>
            Las versiones guardan tanto la matriz de RAs/EC como los datos generales del plan institucional.
          </p>
          <div className="version-item current">
            <div className="info">
              <div className="version-num"><i className="fas fa-check" /></div>
              <div>
                <strong>Version actual</strong>
                <p style={{ fontSize: '0.82rem', color: '#6b7280' }}>{plans.length} RAs, {totalEC} EC, {totalHours} horas</p>
              </div>
            </div>
            <span className="status-badge active">Actual</span>
          </div>

          {versionsLoading ? (
            <div style={{ textAlign: 'center', padding: '1.25rem', color: '#6b7280' }}>
              <i className="fas fa-spinner fa-spin" style={{ marginRight: 6 }} />Cargando versiones...
            </div>
          ) : versions.length === 0 ? (
            <div className="empty-state" style={{ padding: '1rem' }}>
              <i className="fas fa-clock-rotate-left" />
              <h3>Sin versiones guardadas</h3>
              <p>Las versiones apareceran despues de editar, copiar o restaurar el plan.</p>
            </div>
          ) : versions.map(version => {
            const parsed = parseVersionSnapshot(version.snapshot)
            const summary = version.summary || summarizeRows(parsed.rows)
            return (
              <div className="version-item" key={version.id}>
                <div className="info">
                  <div className="version-num">v{version.version_number}</div>
                  <div>
                    <strong>
                      {version.action === 'copy'
                        ? 'Copia de plan'
                        : version.action === 'restore'
                          ? 'Restauracion'
                          : version.action === 'baseline'
                            ? 'Version inicial'
                            : 'Actualizacion del plan'}
                    </strong>
                    <p style={{ fontSize: '0.82rem', color: '#6b7280' }}>
                      {new Date(version.created_at).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' })}
                      {version.source_course ? ` - Desde ${version.source_course} (${version.source_year})` : ''}
                    </p>
                    <p style={{ fontSize: '0.78rem', color: '#9ca3af' }}>
                      {summary.total_ras || 0} RAs, {summary.total_ec || 0} EC, {summary.total_hours || 0} horas
                    </p>
                    <p style={{ fontSize: '0.78rem', color: '#9ca3af' }}>
                      Modulo: {parsed.meta?.module_name || planMeta.module_name || 'Sin modulo'} / Plantilla: {parsed.meta?.template_reference || 'Base'}
                    </p>
                  </div>
                </div>
                <button className="btn btn-sm btn-secondary" onClick={() => restoreVersion(version)}><i className="fas fa-undo" /> Restaurar</button>
              </div>
            )
          })}
        </Modal>
      )}

      {cModal && (
        <Modal
          title="Copiar Planificacion de otro periodo"
          icon="fa-copy"
          onClose={() => setCModal(false)}
          maxWidth="500px"
          footer={<>
            <button className="btn btn-secondary" onClick={() => setCModal(false)}>Cancelar</button>
            <button className="btn btn-primary" onClick={handleCopyPlan} disabled={copying}>
              <i className={`fas ${copying ? 'fa-spinner fa-spin' : 'fa-copy'}`} />{copying ? 'Copiando...' : 'Copiar'}
            </button>
          </>}
        >
          <div className="form-group">
            <label>Ano origen</label>
            <select className="form-control" value={copyForm.year} onChange={e => setCopyForm(prev => ({ ...prev, year: Number(e.target.value) }))}>
              {YEARS.map(option => <option key={option} value={option}>{option}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>Materia origen</label>
            <select className="form-control" value={copyForm.subject} onChange={e => setCopyForm(prev => ({ ...prev, subject: e.target.value }))}>
              {ACADEMIC_SUBJECT_OPTIONS.map(option => <option key={option}>{option}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>Curso origen</label>
            <select className="form-control" value={copyForm.section} onChange={e => setCopyForm(prev => ({ ...prev, section: e.target.value }))} disabled={courseOptions.length === 0}>
              {courseOptions.length === 0 ? (
                <option value="">No hay cursos</option>
              ) : (
                Array.from(new Set([copyForm.section, ...courseOptions].filter(Boolean))).map(option => (
                  <option key={option}>{option}</option>
                ))
              )}
            </select>
          </div>
          <div className="alert-card warning" style={{ marginTop: '1rem' }}>
            <i className="fas fa-exclamation-triangle icon" />
            <div>
              <strong>Atencion</strong>
              <p style={{ fontSize: '0.85rem' }}>
                Esto reemplazara tanto la matriz RA/EC como los datos generales actuales de {course} - {year}.
              </p>
            </div>
          </div>
        </Modal>
      )}
    </section>
  )
}
