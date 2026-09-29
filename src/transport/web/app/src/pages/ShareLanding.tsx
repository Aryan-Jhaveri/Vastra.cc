import { useEffect } from 'react'
import { useParams, useNavigate } from 'react-router'
import { track } from '../lib/analytics'
import { Spinner } from '../components/ui/Spinner'

export function ShareLanding() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  useEffect(() => {
    track('share_opened')
    if (!id) { navigate('/home', { replace: true }); return }

    // Stash the share id for post-login redirect
    localStorage.setItem('closet-pending-share', id)

    // Cookie-only auth: the httpOnly cookie rides this request. No token is
    // read from web storage (#295).
    fetch('/api/auth/me')
      .then(me => {
        if (me.ok) {
          // Already authenticated — go straight to Discover tab
          navigate(`/home#discover?share=${id}`, { replace: true })
        } else {
          // Not authed — redirect to login; App will restore after login
          navigate('/login', { replace: true })
        }
      })
      .catch(() => navigate('/login', { replace: true }))
  }, [id, navigate])

  return (
    <div className="min-h-screen flex items-center justify-center bg-paper">
      <Spinner />
    </div>
  )
}
