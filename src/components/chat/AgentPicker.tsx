import { useCallback } from "react"
import { View, Text, TouchableOpacity, StyleSheet } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import BottomSheet, { BottomSheetBackdrop, BottomSheetFlatList } from "@gorhom/bottom-sheet"
import { useTranslation } from "react-i18next"
import type { Agent } from "../../lib/sdk"

interface Props {
  agents: Agent[]
  selected: string
  isDark: boolean
  onSelect: (name: string) => void
  sheetRef: React.RefObject<BottomSheet | null>
}

export function AgentPicker({ agents, selected, isDark, onSelect, sheetRef }: Props) {
  const { t } = useTranslation()

  const handleSelect = useCallback(
    (name: string) => {
      onSelect(name)
      sheetRef.current?.close()
    },
    [onSelect, sheetRef],
  )

  return (
    <BottomSheet
      ref={sheetRef}
      index={-1}
      snapPoints={["45%", "70%"]}
      // See DirectoryBrowserSheet.tsx for why this is required alongside
      // static snapPoints (issue #104): without it the sheet can never open.
      enableDynamicSizing={false}
      enablePanDownToClose
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      backgroundStyle={isDark ? s.sheetDark : s.sheet}
      handleIndicatorStyle={{ backgroundColor: isDark ? "#666666" : "#cccccc" }}
      backdropComponent={(props) => (
        <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />
      )}
    >
      <View style={s.header}>
        <Text style={[s.title, isDark && s.textWhite]}>{t("chat.agentPicker.title")}</Text>
      </View>
      <BottomSheetFlatList
        data={agents}
        keyExtractor={(item: Agent) => item.name}
        renderItem={({ item }: { item: Agent }) => {
          const active = item.name === selected
          return (
            <TouchableOpacity
              style={[s.row, isDark && s.rowDark, active && (isDark ? s.rowSelectedDark : s.rowSelected)]}
              onPress={() => handleSelect(item.name)}
              testID={`agent-option-${item.name}`}
            >
              <View style={[s.dot, { backgroundColor: item.color || "#8b5cf6" }]} />
              <View style={s.rowText}>
                <Text style={[s.rowName, isDark && s.textWhite]} numberOfLines={1}>
                  {item.name}
                </Text>
                {item.description && (
                  <Text style={[s.rowDesc, isDark && s.metaDark]} numberOfLines={2}>
                    {item.description}
                  </Text>
                )}
              </View>
              {active && <Ionicons name="checkmark-circle" size={20} color="#8b5cf6" />}
            </TouchableOpacity>
          )
        }}
        ListEmptyComponent={
          agents.length === 0 ? (
            <View style={s.emptyBox}>
              <Text style={[s.emptyText, isDark && s.metaDark]}>{t("chat.agentPicker.empty")}</Text>
            </View>
          ) : null
        }
        contentContainerStyle={s.content}
      />
    </BottomSheet>
  )
}

const s = StyleSheet.create({
  sheet: { backgroundColor: "#ffffff" },
  sheetDark: { backgroundColor: "#1a1a1a" },
  header: { paddingHorizontal: 16, paddingBottom: 8 },
  title: { fontSize: 18, fontWeight: "700", color: "#0a0a0a" },
  textWhite: { color: "#ffffff" },
  content: { paddingBottom: 40 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e5e5e5",
  },
  rowDark: { borderBottomColor: "#2a2a2a" },
  rowSelected: { backgroundColor: "#f5f3ff" },
  rowSelectedDark: { backgroundColor: "#1f1a2e" },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  rowText: { flex: 1 },
  rowName: { fontSize: 15, fontWeight: "500", color: "#0a0a0a" },
  rowDesc: { fontSize: 12, color: "#999999", marginTop: 2 },
  metaDark: { color: "#666666" },
  emptyBox: { paddingVertical: 24, alignItems: "center" },
  emptyText: { fontSize: 13, color: "#999999" },
})
