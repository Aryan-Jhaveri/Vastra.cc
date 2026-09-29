export function VastraLoader() {
  return (
    <div className="flex flex-col items-center justify-center py-12 gap-5">
      <p className="text-[18px] font-bold font-mono uppercase tracking-[0.1em] text-ink">Vastra</p>
      <div className="flex gap-2">
        <div className="w-2 h-2 bg-ink animate-bounce" style={{ animationDuration: '1s' }} />
        <div className="w-2 h-2 bg-ink animate-bounce" style={{ animationDuration: '1s', animationDelay: '0.15s' }} />
        <div className="w-2 h-2 bg-ink animate-bounce" style={{ animationDuration: '1s', animationDelay: '0.3s' }} />
      </div>
    </div>
  )
}
