import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  useColorScheme,
} from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { router, useLocalSearchParams, Stack } from "expo-router"
import { useTranslation } from "react-i18next"
import { useConnections } from "../src/stores/connections"
import { parentOf, nameOf } from "../src/lib/path-utils"
import type { FileEntry, GitFileStatus } from "../src/lib/sdk"

const STATUS_COLORS: Record<GitFileStatus["status"], string> = {
  added: "#10b981",
  modified: "#f59e0b",
  deleted: "#ef4444",
}

interface Row {
  key: string
  name: string
  isDir: boolean
  absolute: string
  ignored: boolean
  status?: GitFileStatus["status"]
}

export default function FileBrowser() {
  const { dir, fallback } = useLocalSearchParams<{ dir?: string; fallback?: string }>()
  const { t } = useTranslation()
  const isDark = useColorScheme() === "dark"
  const { client, clientForDirectory, activeConnection, currentProject, serverHome } = useConnections()

  // dir = the directory currently being listed. First screen of a fresh
  // browse chain has no `dir` — it falls back through the chain below to
  // the session/connection project root.
  const browseDir = dir || fallback || activeConnection?.directory || currentProject?.path?.absolute || serverHome

  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statuses, setStatuses] = useState<Map<string, GitFileStatus["status"]>>(new Map())
  const token = useRef(0)

  useEffect(() => {
    const target = browseDir
    if (!target) {
      setLoading(false)
      setError(t("fileBrowser.noConnection"))
      return
    }
    const c = clientForDirectory(target) || client
    if (!c) {
      setLoading(false)
      setError(t("fileBrowser.noConnection"))
      return
    }
    const cur = ++token.current
    setLoading(true)
    setError(null)
    // Clear any previous directory's status dots so they don't briefly
    // decorate the new listing before its own /file/status resolves.
    setStatuses(new Map())
    c.file
      .list({ path: "." })
      .then((items) => {
        if (token.current !== cur) return
        setRows(items.map((item) => ({ key: item.absolute, name: item.name, isDir: item.type === "directory", absolute: item.absolute, ignored: item.ignored })))
      })
      .catch((err) => {
        if (token.current !== cur) return
        setError(err instanceof Error ? err.message : t("fileBrowser.listFailed"))
      })
      .finally(() => {
        if (token.current === cur) setLoading(false)
      })
    // Git status is optional decoration — older servers 404 it, and a
    // failure here must never block the listing itself.
    c.file
      .status()
      .then((s) => {
        if (token.current !== cur) return
        const map = new Map<string, GitFileStatus["status"]>()
        if (s) for (const item of s) map.set(item.path, item.status)
        setStatuses(map)
      })
      .catch(() => {
        if (token.current === cur) setStatuses(new Map())
      })
  }, [browseDir, client, clientForDirectory, t])

  const sorted = useMemo(() => {
    const withStatus = rows.map((r) => ({ ...r, status: statuses.get(r.name) }))
    withStatus.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return withStatus
  }, [rows, statuses])

  const goUp = useCallback(() => {
    if (browseDir && parentOf(browseDir)) {
      router.push({
        pathname: "/file-browser",
        params: { dir: parentOf(browseDir), fallback },
      })
    }
  }, [browseDir, fallback])

  const openDir = useCallback(
    (absolute: string) => {
      router.push({ pathname: "/file-browser", params: { dir: absolute, fallback } })
    },
    [fallback],
  )

  const openFile = useCallback(
    (absolute: string) => {
      router.push({ pathname: "/file-preview", params: { path: absolute, dir: browseDir ?? undefined } })
    },
    [browseDir],
  )

  return (
    <>
      <Stack.Screen options={{ title: browseDir ? nameOf(browseDir) : t("fileBrowser.title") }} />
      {!browseDir ? (
        <View style={[s.center, isDark && s.centerDark]}>
          <Ionicons name="folder-outline" size={40} color={isDark ? "#444444" : "#cccccc"} />
          <Text style={[s.centerText, isDark && s.dimDark]}>{t("fileBrowser.noConnection")}</Text>
        </View>
      ) : (
        <>
          {parentOf(browseDir) && (
            <View style={s.toolbar}>
              <TouchableOpacity
                onPress={goUp}
                style={[s.upBtn, isDark && s.upBtnDark]}
                hitSlop={8}
                testID="file-browser-up"
              >
                <Ionicons name="arrow-back-outline" size={18} color={isDark ? "#c4b5fd" : "#6d28d9"} />
                <Text style={[s.upLabel, isDark && s.dimDark]}>{t("fileBrowser.up")}</Text>
              </TouchableOpacity>
            </View>
          )}
          <FlatList
            data={sorted}
            keyExtractor={(item) => item.key}
            testID="file-browser-list"
            renderItem={({ item }: { item: Row & { status?: GitFileStatus["status"] } }) => (
              <TouchableOpacity
                style={[s.row, isDark && s.rowDark, item.ignored && s.rowIgnored]}
                onPress={() => (item.isDir ? openDir(item.absolute) : openFile(item.absolute))}
                testID={`file-row-${item.name}`}
              >
                <Ionicons
                  name={item.isDir ? "folder-outline" : "document-outline"}
                  size={18}
                  color={isDark ? "#888888" : "#666666"}
                />
                <Text style={[s.rowLabel, isDark && s.white, item.ignored && s.rowIgnoredText]} numberOfLines={1}>
                  {item.name}
                </Text>
                {item.status && (
                  <View style={[s.statusDot, { backgroundColor: STATUS_COLORS[item.status] }]} />
                )}
              </TouchableOpacity>
            )}
            contentContainerStyle={s.list}
            ListHeaderComponent={
              loading ? (
                <View style={s.centerBox}>
                  <ActivityIndicator color={isDark ? "#ffffff" : "#0a0a0a"} />
                </View>
              ) : error ? (
                <View style={s.centerBox}>
                  <Text style={s.errorText}>{error}</Text>
                </View>
              ) : null
            }
            ListEmptyComponent={
              !loading && !error ? (
                <Text style={[s.emptyText, isDark && s.dimDark]}>{t("fileBrowser.empty")}</Text>
              ) : null
            }
          />
        </>
      )}
    </>
  )
}

const s = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", alignItems: "center", gap: 8 },
  centerDark: {},
  centerText: { fontSize: 14, color: "#999999" },
  dimDark: { color: "#666666" },
  white: { color: "#ffffff" },
  toolbar: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  upBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    backgroundColor: "#f5f3ff",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  upBtnDark: { backgroundColor: "#2a1a3e" },
  upLabel: { fontSize: 13, fontWeight: "600", color: "#6d28d9" },
  list: {
    paddingHorizontal: 12,
    paddingBottom: 32,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: "#f5f5f5",
    marginBottom: 6,
  },
  rowDark: { backgroundColor: "#1f1f1f" },
  rowIgnored: { opacity: 0.55 },
  rowLabel: { flex: 1, fontSize: 15, color: "#0a0a0a" },
  rowIgnoredText: { color: "#999999" },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  centerBox: {
    paddingVertical: 32,
    alignItems: "center",
  },
  errorText: {
    fontSize: 13,
    color: "#ef4444",
    textAlign: "center",
    paddingHorizontal: 24,
  },
  emptyText: {
    fontSize: 13,
    color: "#999999",
    textAlign: "center",
    paddingVertical: 24,
  },
})
