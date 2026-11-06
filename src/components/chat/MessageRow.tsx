import { useLayoutEffect, useRef, type ReactNode } from "react"
import { Animated } from "react-native"

// Mount-time fade-in for message rows. Two moments make rows appear abruptly:
// a foreground resume (several fetches land at once and new messages snap in)
// and virtualization mounting rows while scrolling. A short native-driven
// opacity fade (UI thread, so it stays smooth while JS is busy processing the
// resumed fetches) softens both — the same "settle" effect the session
// screen's resume fade gives the whole list, but for individual new rows.
//
// Deliberately a wrapper around MessageBubble: the bubble itself must stay a
// plain memoized component (regression tests assert its exact source shape),
// and keeping the animation here means every mount fades — cold loads, resume
// arrivals, and scroll-mounted rows alike, consistently.
//
// useLayoutEffect (not useEffect): a passive effect runs AFTER paint, so the
// first frame would render at opacity 0 and — exactly when the JS thread is
// slammed by resumed fetches, the target scenario — the row could sit blank
// for hundreds of ms instead of fading. Starting the animation before paint
// keeps the fade immediate.
export function MessageRow({ children }: { children: ReactNode }) {
  const opacity = useRef(new Animated.Value(0)).current
  useLayoutEffect(() => {
    Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }).start()
    return () => opacity.stopAnimation()
  }, [opacity])
  return <Animated.View style={{ opacity }}>{children}</Animated.View>
}
