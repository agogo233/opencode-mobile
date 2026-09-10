import { useEffect, useMemo, useState } from "react"
import {
  View,
  Text,
  Image,
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  useColorScheme,
} from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { useLocalSearchParams, Stack } from "expo-router"
import { useTranslation } from "react-i18next"
import { useConnections } from "../src/stores/connections"
import { CodeBlock } from "../src/components/markdown"
import { nameOf, parentOf, stripTrailingSlash } from "../src/lib/path-utils"
import { langForPath, mimeForPath, isImageMime } from "../src/lib/file-mime"
import { ApiError } from "../src/lib/sdk"

// Cap the rendered text so a 10MB log file can't freeze the list view.
const MAX_PREVIEW_CHARS = 200_000

export default function FilePreview() {
  const { path: filePath, dir } = useLocalSearchParams<{ path?: string; dir?: string }>()
  const { t } = useTranslation()
  const isDark = useColorScheme() === "dark"
  const { client, clientForDirectory } = useConnections()

  const [content, setContent] = useState<string | null>(null)
  const [meta, setMeta] = useState<{ type: string; mimeType?: string; encoding?: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Read the file from its own parent directory (rooted client), which
  // keeps path handling simple: name only, directory = parent. Trailing
  // separators are stripped so a Windows parent like "C:\" stays header-safe.
  const parent = useMemo(() => {
    if (!filePath) return null
    const p = parentOf(filePath) || (dir ? stripTrailingSlash(dir) : null)
    return p ? stripTrailingSlash(p) : null
  }, [filePath, dir])

  useEffect(() => {
    if (!filePath) return
    const c = (parent ? clientForDirectory(parent) : null) || client
    if (!c) {
      setError(t("filePreview.readFailed"))
      setLoading(false)
      return
    }
    let cancel = false
    setLoading(true)
    setError(null)
    c.file
      .read({ path: nameOf(filePath) })
      .then((res) => {
        if (cancel) return
        setContent(res.content)
        setMeta({ type: res.type, mimeType: res.mimeType, encoding: res.encoding })
      })
      .catch((err) => {
        if (cancel) return
        setError(err instanceof ApiError ? t("filePreview.readFailed") : err instanceof Error ? err.message : t("filePreview.readFailed"))
      })
      .finally(() => {
        if (!cancel) setLoading(false)
      })
    return () => {
      cancel = true
    }
  }, [filePath, parent, client, clientForDirectory, t])

  const truncated = content !== null && content.length > MAX_PREVIEW_CHARS
  const display = truncated ? content.slice(0, MAX_PREVIEW_CHARS) : content

  const body = () => {
    if (!meta) return null
    if (meta.type === "text") {
      // CodeBlock scrolls wide lines horizontally on its own; the outer
      // scroll here is vertical only.
      return (
        <ScrollView testID="file-preview-content" style={s.bodyScroll}>
          <CodeBlock code={display ?? ""} language={filePath ? langForPath(filePath) : undefined} />
          {truncated && (
            <Text style={[s.truncatedNote, isDark && s.truncatedDark]}>{t("filePreview.truncated")}</Text>
          )}
        </ScrollView>
      )
    }
    const mime = meta.mimeType || (filePath ? mimeForPath(filePath) : "")
    if (isImageMime(mime) && content) {
      const dataUri = `data:${mime};base64,${content}`
      return (
        <ScrollView testID="file-preview-content" style={s.bodyScroll} contentContainerStyle={s.imageBody}>
          <Image source={{ uri: dataUri }} style={s.previewImage} resizeMode="contain" />
        </ScrollView>
      )
    }
    return (
      <View style={s.centerBox}>
        <Ionicons name="document-text-outline" size={32} color={isDark ? "#444444" : "#cccccc"} />
        <Text style={[s.centerText, isDark && s.centerDark]}>{t("filePreview.unsupported")}</Text>
      </View>
    )
  }

  return (
    <>
      <Stack.Screen options={{ title: filePath ? nameOf(filePath) : t("filePreview.title") }} />
      {filePath && (
        <Text style={[s.pathBar, isDark && s.pathBarDark]} numberOfLines={1} ellipsizeMode="middle">
          {filePath}
        </Text>
      )}
      {loading ? (
        <View style={s.centerBox}>
          <ActivityIndicator color={isDark ? "#ffffff" : "#0a0a0a"} />
        </View>
      ) : error ? (
        <View style={s.centerBox}>
          <Text style={s.errorText}>{error}</Text>
        </View>
      ) : (
        body()
      )}
    </>
  )
}

const s = StyleSheet.create({
  pathBar: {
    fontSize: 12,
    color: "#999999",
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  pathBarDark: { color: "#666666" },
  bodyScroll: { flex: 1 },
  centerBox: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    padding: 24,
  },
  centerText: { fontSize: 13, color: "#999999", textAlign: "center" },
  centerDark: { color: "#666666" },
  errorText: {
    fontSize: 13,
    color: "#ef4444",
    textAlign: "center",
    paddingHorizontal: 24,
  },
  truncatedNote: {
    fontSize: 12,
    color: "#999999",
    textAlign: "center",
    paddingVertical: 8,
  },
  truncatedDark: { color: "#666666" },
  imageBody: {
    alignItems: "center",
    padding: 16,
  },
  previewImage: {
    maxWidth: "100%",
    maxHeight: 600,
    borderRadius: 8,
  },
})
