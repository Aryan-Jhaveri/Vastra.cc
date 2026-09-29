import { useEffect, type RefObject } from 'react'

export function useMountAnimation(
  ref: RefObject<HTMLElement | null>,
  keyframes: Keyframe[],
  options?: KeyframeAnimationOptions,
) {
  useEffect(() => {
    ref.current?.animate(keyframes, {
      duration: 200,
      easing: 'ease-out',
      fill: 'backwards',
      ...options,
    })
  }, [])
}
