'use client'
import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { apiFetch } from './api'

interface User {
  id: string
  full_name: string
  role: string
  username: string
}

interface AuthCtx {
  user: User | null
  login: (creds: { username: string; password: string }) => Promise<void>
  logout: () => void
  isLoading: boolean
}

const AuthContext = createContext<AuthCtx>(null!)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const token = localStorage.getItem('access_token')
    if (token) {
      apiFetch<{ data: User }>('/auth/me')
        .then((r) => setUser(r.data))
        .catch(() => setUser(null))
        .finally(() => setIsLoading(false))
    } else {
      setIsLoading(false)
    }
  }, [])

  const login = async (creds: { username: string; password: string }) => {
    const r = await apiFetch<{
      data: { access_token: string; refresh_token: string; user: User }
    }>('/auth/login', { method: 'POST', body: JSON.stringify(creds) })
    localStorage.setItem('access_token', r.data.access_token)
    localStorage.setItem('refresh_token', r.data.refresh_token)
    setUser(r.data.user)
  }

  const logout = () => {
    localStorage.removeItem('access_token')
    localStorage.removeItem('refresh_token')
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, login, logout, isLoading }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
