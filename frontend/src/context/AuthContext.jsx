import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { clearPersistedSession, supabase } from '../services/supabaseClient.js'
import { notificationService } from '../services/api.js'
import { recordAuditEvent } from '../services/auditLogger.js'
import { isInactiveProfile, isPendingProfile } from '../services/accessControl.js'
import { buildPrimaryDirectorProfile, isPrimaryDirectorEmail } from '../services/systemConfig.js'

const AuthContext = createContext(null)
const PROFILE_TIMEOUT_MS = 7000

const withTimeout = async (promise, label) => {
  let timerId

  const timeoutPromise = new Promise((_, reject) => {
    timerId = window.setTimeout(() => reject(new Error(`${label} timeout`)), PROFILE_TIMEOUT_MS)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    window.clearTimeout(timerId)
  }
}

const clearLocalSession = async () => {
  try {
    clearPersistedSession()
  } catch (error) {
    console.error('No se pudo limpiar la sesion local:', error)
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [profileLoading, setProfileLoading] = useState(false)
  const lastSessionCheckAt = useRef(0)

  const buildFallbackProfile = (authUser) => {
    if (!authUser) return null

    if (isPrimaryDirectorEmail(authUser.email)) {
      return buildPrimaryDirectorProfile(authUser)
    }

    return {
      id: authUser.id,
      email: authUser.email,
      full_name: authUser.user_metadata?.full_name || authUser.email || 'Usuario',
      role: 'pending',
      status: 'pending',
    }
  }

  const ensureProfile = async (authUser) => {
    if (!authUser) {
      setProfile(null)
      setProfileLoading(false)
      return null
    }

    setProfileLoading(true)

    try {
      const { data, error } = await withTimeout(
        supabase
          .from('profiles')
          .select('*')
          .eq('id', authUser.id)
          .maybeSingle(),
        'profiles.select'
      )

      if (error) throw error

      if (data) {
        setProfile(data)
        return data
      }

      const fallback = buildFallbackProfile(authUser)
      setProfile(fallback)
      return fallback
    } catch (error) {
      console.error('No se pudo cargar el perfil:', error)
      const fallback = buildFallbackProfile(authUser)
      setProfile(fallback)
      return fallback
    } finally {
      setProfileLoading(false)
    }
  }

  const resetAuthState = () => {
    setUser(null)
    setProfile(null)
    setProfileLoading(false)
    setLoading(false)
  }

  useEffect(() => {
    let active = true
    const currentPath = typeof window !== 'undefined' ? window.location.pathname : ''
    const isAuthScreen = currentPath === '/login' || currentPath === '/register'

    const syncSession = async () => {
      try {
        const { data, error } = await supabase.auth.getSession()
        if (error) throw error

        const sessionUser = data?.session?.user ?? null
        if (!active) return

        if (!sessionUser) {
          setUser(null)
          setProfile(null)
          setProfileLoading(false)
          setLoading(false)
          lastSessionCheckAt.current = Date.now()
          return
        }

        const { data: userData, error: userError } = await supabase.auth.getUser()
        if (userError) throw userError

        const validatedUser = userData?.user ?? null
        if (!validatedUser) {
          await clearLocalSession()
          if (active) resetAuthState()
          return
        }

        setUser(validatedUser)
        setLoading(false)
        lastSessionCheckAt.current = Date.now()

        ensureProfile(validatedUser).catch((sessionError) => {
          console.error(sessionError)
        })
      } catch (error) {
        console.error(error)
        await clearLocalSession()
        if (active) resetAuthState()
      }
    }

    const bootstrap = async () => {
      try {
        if (isAuthScreen) {
          if (active) resetAuthState()
          return
        }
        await syncSession()
      } catch (error) {
        console.error(error)
        await clearLocalSession()
        if (active) resetAuthState()
      }
    }

    bootstrap()

    if (isAuthScreen) {
      return () => {
        active = false
      }
    }

    const { data: listener } = supabase.auth.onAuthStateChange(async (_event, session) => {
      const sessionUser = session?.user ?? null
      if (!active) return
      setUser(sessionUser)
      setLoading(false)
      ensureProfile(sessionUser).catch(error => console.error(error))
    })

    const handleSessionWake = () => {
      if (document.visibilityState === 'visible') {
        const now = Date.now()
        if (now - lastSessionCheckAt.current > 5000) {
          syncSession().catch(error => console.error(error))
        }
      }
    }

    const handleWindowFocus = () => {
      const now = Date.now()
      if (now - lastSessionCheckAt.current > 5000) {
        syncSession().catch(error => console.error(error))
      }
    }

    window.addEventListener('focus', handleWindowFocus)
    document.addEventListener('visibilitychange', handleSessionWake)

    return () => {
      active = false
      window.removeEventListener('focus', handleWindowFocus)
      document.removeEventListener('visibilitychange', handleSessionWake)
      listener.subscription.unsubscribe()
    }
  }, [])

  const login = async (email, password) => {
    await clearLocalSession()
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error

    const resolvedUser = data?.user
    setUser(resolvedUser ?? null)
    const nextProfile = await ensureProfile(resolvedUser)

    return { ...data, user: resolvedUser, profile: nextProfile }
  }

  const register = async (email, password, name) => {
    const normalizedEmail = String(email || '').trim().toLowerCase()
    const { data, error } = await supabase.auth.signUp({
      email: normalizedEmail,
      password,
      options: {
        data: {
          full_name: name,
        },
      },
    })

    if (error) throw error
    // Supabase sometimes returns no error but no user when the email already exists.
    // We convert that into a clear message so the UI doesn't "look like it worked".
    if (!data?.user) {
      throw new Error('Este correo ya esta registrado. Inicia sesion.')
    }

    const nextProfile = await ensureProfile(data?.user)
    await recordAuditEvent({
      user: data?.user,
      module: 'Autenticacion',
      action: 'Registro de usuario',
      details: name || email,
      type: 'auth',
    })

    notificationService.sendRegistrationNotice({
      name,
      email,
    }).catch((error) => {
      console.error('No se pudo enviar el correo de registro:', error)
    })

    return { ...data, profile: nextProfile }
  }

  const logout = async () => {
    const currentUser = user
    await recordAuditEvent({
      user: currentUser,
      module: 'Autenticacion',
      action: 'Cierre de sesion',
      details: currentUser?.email || '',
      type: 'auth',
    })
    await supabase.auth.signOut()
    setUser(null)
    setProfile(null)
    setProfileLoading(false)
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        profileLoading,
        login,
        register,
        logout,
        refreshProfile: () => ensureProfile(user),
        isPending: !profileLoading && isPendingProfile(profile),
        isInactive: !profileLoading && isInactiveProfile(profile),
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
