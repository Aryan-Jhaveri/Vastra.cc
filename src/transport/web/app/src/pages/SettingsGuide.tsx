import { useNavigate } from 'react-router'
import { ArrowLeft, Share2, Sparkles, Shirt } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'

const SECTIONS = [
  {
    icon: Sparkles,
    title: 'Personal Stylist',
    blurb:
      "Use Vastra's AI models to bring you suggestion from your closet! Go to Home → Suggest and click on occasion blobs, or Home → Discover tab → Image to find outfits in your closet like a photo you upload, or Link to open an outfit someone shared with you!",
  },
  {
    icon: Share2,
    title: 'Share & Coordinate',
    blurb:
      'Send an outfit link to a friend — they see the look in their browser, no account needed. Great for coordinating before events',
  },
  {
    icon: Shirt,
    title: 'Quick Try-on',
    blurb:
      'Pick any item (or a full outfit) from your closet, upload a photo of yourself, and Vastra generates a realistic preview of how it looks on you — powered by Gemini.',
  }, 
]


export function SettingsGuide() {
  const navigate = useNavigate()

  return (
    <div className="flex flex-col p-4 pb-20">
      <button
        onClick={() => navigate('/settings')}
        className="flex items-center gap-2 mb-4 text-muted hover:text-ink transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        <span className="text-[14px] font-bold font-mono uppercase tracking-[0.1em]">Settings</span>
      </button>

      <PageHeader title="Guide." hideEmptySubtitle={true} />
      <div className="mb-6" />

      <div className="flex flex-col gap-6">
        {SECTIONS.map(({ icon: Icon, title, blurb }) => (
          <div key={title} className="border-2 border-ink rounded-base p-4 bg-surface">
            <div className="flex items-center gap-2 mb-2">
              <Icon className="w-4 h-4 text-accent" />
              <p className="text-[14px] font-bold font-mono uppercase tracking-[0.1em]">{title}</p>
            </div>
            <p className="text-sm font-mono text-muted leading-relaxed">{blurb}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
