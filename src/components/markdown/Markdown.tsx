import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { View, Text, useColorScheme, Platform, type StyleProp, type ViewStyle, type TextStyle } from "react-native"
import { useMarkdown, Renderer } from "react-native-marked"
import { CodeBlock } from "./CodeBlock"

// react-native-marked's base Renderer hardcodes `selectable` on every plain
// text node it produces (text/strong/em/del/heading/codespan). On Android,
// selectable <Text> nested inside a FlatList row has a long-standing,
// still-unresolved RN bug (facebook/react-native#46999, a reopened
// regression of #28952's fix) where the underlying view's selectable state
// — and, per our own diff-scroll flow (issue #104), its exposure to the
// accessibility tree Maestro/UiAutomator reads from — never gets applied
// correctly. Chat messages here are rendered as rows of the session screen's
// own FlatList (app/session/[id].tsx), so every markdown text node hits
// this. Code content is still copyable via CodeBlock's explicit Copy
// button, so dropping `selectable` on plain text costs little.
class CustomRenderer extends Renderer {
  private plainText(children: string | ReactNode[], styles?: StyleProp<TextStyle>): ReactNode {
    return (
      <Text key={this.getKey()} style={styles}>
        {children}
      </Text>
    )
  }

  code(text: string, language?: string, containerStyle?: ViewStyle, _textStyle?: TextStyle) {
    return (
      <View key={this.getKey()} style={containerStyle}>
        <CodeBlock code={text} language={language} />
      </View>
    )
  }

  text(text: string | ReactNode[], styles?: TextStyle): ReactNode {
    return this.plainText(text, styles)
  }

  strong(children: string | ReactNode[], styles?: TextStyle): ReactNode {
    return this.plainText(children, styles)
  }

  em(children: string | ReactNode[], styles?: TextStyle): ReactNode {
    return this.plainText(children, styles)
  }

  del(children: string | ReactNode[], styles?: TextStyle): ReactNode {
    return this.plainText(children, styles)
  }

  heading(text: string | ReactNode[], styles?: TextStyle): ReactNode {
    return this.plainText(text, styles)
  }

  codespan(text: string, styles?: TextStyle): ReactNode {
    return this.plainText(text, [styles, { fontStyle: "normal", fontWeight: "normal" }])
  }
}

const mono = Platform.OS === "ios" ? "Menlo" : "monospace"

// Min gap between full markdown re-parses while a message streams in. ~20
// updates/sec reads as smooth while cutting the O(n)-per-token re-parse count
// of a long reply by an order of magnitude versus parsing every token.
const STREAM_PARSE_INTERVAL_MS = 50

const lightTheme = {
  text: { color: "#0a0a0a", fontSize: 15, lineHeight: 22 },
  paragraph: { marginTop: 0, marginBottom: 8 },
  h1: { fontSize: 22, fontWeight: "700" as const, color: "#0a0a0a", marginBottom: 8, marginTop: 12 },
  h2: { fontSize: 19, fontWeight: "600" as const, color: "#0a0a0a", marginBottom: 6, marginTop: 10 },
  h3: { fontSize: 16, fontWeight: "600" as const, color: "#0a0a0a", marginBottom: 4, marginTop: 8 },
  link: { color: "#8b5cf6" },
  blockquote: {
    backgroundColor: "transparent",
    borderLeftWidth: 3,
    borderLeftColor: "#d1d5db",
    paddingLeft: 12,
    paddingVertical: 2,
    marginVertical: 4,
  },
  code: {
    backgroundColor: "#e8e5f0",
    color: "#6d28d9",
    fontFamily: mono,
    fontSize: 13,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
  },
  codespan: {
    backgroundColor: "#e8e5f0",
    color: "#6d28d9",
    fontFamily: mono,
    fontSize: 13,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
  },
  list: { marginBottom: 4 },
  li: { marginBottom: 2 },
  hr: { backgroundColor: "#e5e5e5", height: 1, marginVertical: 12 },
  strong: { fontWeight: "700" as const },
  em: { fontStyle: "italic" as const },
  strikethrough: { textDecorationLine: "line-through" as const },
  image: { borderRadius: 8 },
}

const darkTheme = {
  ...lightTheme,
  text: { ...lightTheme.text, color: "#e5e5e5" },
  h1: { ...lightTheme.h1, color: "#ffffff" },
  h2: { ...lightTheme.h2, color: "#ffffff" },
  h3: { ...lightTheme.h3, color: "#ffffff" },
  link: { color: "#a78bfa" },
  blockquote: {
    ...lightTheme.blockquote,
    borderLeftColor: "#4a4a5a",
  },
  code: {
    ...lightTheme.code,
    backgroundColor: "#2a2040",
    color: "#c4b5fd",
  },
  codespan: {
    ...lightTheme.codespan,
    backgroundColor: "#2a2040",
    color: "#c4b5fd",
  },
  hr: { ...lightTheme.hr, backgroundColor: "#2a2a2a" },
}

interface Props {
  children: string
}

// Re-parse throttle for streamed markdown.
//
// During streaming the bubble's text grows a token at a time, and useMarkdown
// re-lexes/re-parses the WHOLE message on every value change — O(n) per token,
// O(n^2) over a long reply, which is the per-frame jank while the agent types.
// This hook coalesces those value changes so the parse runs at most once per
// window instead of once per token.
//
// It throttles DISPLAY ONLY: the store always holds the authoritative latest
// parts (nothing here touches data), and the trailing update guarantees the
// final value lands once the stream stops, so no content is ever lost. A static
// message whose value never changes does a single leading update to the same
// value and schedules nothing — zero overhead for already-complete messages.
function useThrottledValue(value: string, delayMs: number): string {
  const [state, setState] = useState(value)
  const valueRef = useRef(value)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastRef = useRef(0)
  valueRef.current = value

  useEffect(() => {
    const now = Date.now()
    const elapsed = now - lastRef.current
    if (elapsed >= delayMs) {
      // Leading update — render immediately if we're outside the window.
      lastRef.current = now
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      setState(valueRef.current)
    } else if (timerRef.current == null) {
      // Inside the window — schedule one trailing update to the latest value.
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        lastRef.current = Date.now()
        setState(valueRef.current)
      }, delayMs - elapsed)
    }
  }, [value, delayMs])

  // Clear any pending trailing update on unmount.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  return state
}

export function Markdown({ children }: Props) {
  const isDark = useColorScheme() === "dark"
  const theme = isDark ? darkTheme : lightTheme

  // Coalesce streamed re-parses (see useThrottledValue). Feeding the throttled
  // text to useMarkdown means the expensive full parse runs at most once per
  // window during streaming; between those updates useMarkdown's own memo on
  // the unchanged value returns the cached elements, so the subtree doesn't
  // re-render either.
  const throttled = useThrottledValue(children ?? "", STREAM_PARSE_INTERVAL_MS)

  // A module-scope singleton renderer would share one CustomRenderer (and
  // its underlying github-slugger) across every Markdown instance and every
  // streamed token forever. github-slugger never resets, so its heading-slug
  // keys only ever climb — which fed into useMarkdown's memoized parser and
  // made the emitted React keys change on every token, remounting the whole
  // subtree (resetting code-block scroll position, flashing content). Scoping
  // the renderer to the *throttled* value resets the slugger per parse, so keys
  // are deterministic (and stable) for a given value.
  //
  // Keying on `throttled` (not the raw `children`) is what makes the throttle
  // actually save work: useMarkdown memoizes its parser on the renderer's
  // identity, so a renderer rebuilt every token would rebuild the parser and
  // force a full re-parse every token even while the throttled value sat still.
  // Keying on `throttled` keeps the renderer (and thus the parser and the
  // cached parse) stable across the tokens within one throttle window. The #104
  // invariant — one fresh renderer/slugger per distinct displayed value — still
  // holds, so keys never drift.
  const renderer = useMemo(() => new CustomRenderer(), [throttled])

  // react-native-marked's default <RNMarkdown> export renders blocks inside a
  // FlatList. Chat messages are rendered inside app/session/[id].tsx's own
  // *inverted* FlatList (each row a MessageBubble) — nesting one
  // VirtualizedList inside another, especially an inverted one, is a known
  // React Native footgun where the inner list's content can fail to lay out
  // (renders zero height) instead of just warning. We already force
  // scrollEnabled: false and a large initialNumToRender here, which defeats
  // virtualization anyway, so there's nothing to lose by rendering the parsed
  // blocks directly with the useMarkdown hook instead (issue #104).
  const elements = useMarkdown(throttled, {
    renderer,
    styles: theme,
    colorScheme: isDark ? "dark" : "light",
  })

  if (!children?.trim()) return null

  return <View style={{ backgroundColor: "transparent" }}>{elements}</View>
}
