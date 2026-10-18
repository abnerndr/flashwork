import { type ComponentType } from 'react'
import { type LucideProps } from 'lucide-react'

export function UiIcon({
  icon: Icon,
  size = 16,
  strokeWidth = 1.75,
  ...rest
}: LucideProps & { icon: ComponentType<LucideProps> }) {
  return <Icon size={size} strokeWidth={strokeWidth} aria-hidden {...rest} />
}
