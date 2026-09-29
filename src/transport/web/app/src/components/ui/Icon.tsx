import { type ComponentType, type SVGProps } from 'react'

type LucideIconProps = SVGProps<SVGSVGElement> & { size?: number | string }
type LucideIcon = ComponentType<LucideIconProps>

interface IconProps extends Omit<LucideIconProps, 'ref'> {
  icon: LucideIcon
  size?: number
  strokeWidth?: number
}

export function Icon({ icon: IconComponent, size, strokeWidth = 2, className, ...props }: IconProps) {
  return (
    <IconComponent
      size={size}
      strokeWidth={strokeWidth}
      className={className}
      {...props}
    />
  )
}
