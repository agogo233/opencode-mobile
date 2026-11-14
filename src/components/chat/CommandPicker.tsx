import { View, Text, TouchableOpacity, StyleSheet } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import BottomSheet, { BottomSheetBackdrop, BottomSheetFlatList } from "@gorhom/bottom-sheet"
import { useTranslation } from "react-i18next"
import type { SlashCommand } from "./SlashPopover"

interface Props {
  commands: SlashCommand[]
  isDark: boolean
  onSelect: (cmd: SlashCommand) => void
  sheetRef: React.RefObject<BottomSheet | null>
}

export function CommandPicker({ commands, isDark, onSelect, sheetRef }: Props) {
  const { t } = useTranslation()

  const handleSelect = (cmd: SlashCommand) => {
    onSelect(cmd)
    sheetRef.current?.close()
  }

  return (
    <BottomSheet
      ref={sheetRef}
      index={-1}
      snapPoints={["40%", "70%"]}
      enableDynamicSizing={false}
      enablePanDownToClose
      backgroundStyle={isDark ? s.sheetDark : s.sheet}
      handleIndicatorStyle={{ backgroundColor: isDark ? "#666666" : "#cccccc" }}
      backdropComponent={(props) => (
        <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />
      )}
    >
      <View style={s.header}>
        <Text style={[s.title, isDark && s.textWhite]}>{t("chat.commandPicker.title")}</Text>
      </View>
      <BottomSheetFlatList
        data={commands}
        keyExtractor={(item: SlashCommand) => `${item.type}-${item.trigger}`}
        renderItem={({ item }: { item: SlashCommand }) => (
          <TouchableOpacity
            style={[s.row, isDark && s.rowDark]}
            onPress={() => handleSelect(item)}
            testID={`command-option-${item.trigger}`}
          >
            <Ionicons
              name={item.icon as any}
              size={18}
              color={item.type === "custom" ? "#8b5cf6" : isDark ? "#888888" : "#666666"}
            />
            <View style={s.rowText}>
              <Text style={[s.rowName, isDark && s.textWhite]}>/{item.trigger}</Text>
              {item.description ? (
                <Text style={[s.rowDesc, isDark && s.metaDark]} numberOfLines={1}>
                  {item.description}
                </Text>
              ) : null}
            </View>
            {item.type === "custom" && (
              <View style={[s.badge, isDark && s.badgeDark]}>
                <Text style={s.badgeText}>{t("chat.slashPopover.customBadge")}</Text>
              </View>
            )}
          </TouchableOpacity>
        )}
        contentContainerStyle={s.content}
      />
    </BottomSheet>
  )
}

const s = StyleSheet.create({
  sheet: { backgroundColor: "#ffffff" },
  sheetDark: { backgroundColor: "#1a1a1a" },
  header: { paddingHorizontal: 16, paddingBottom: 12 },
  title: { fontSize: 18, fontWeight: "700", color: "#0a0a0a" },
  textWhite: { color: "#ffffff" },
  metaDark: { color: "#666666" },
  content: { paddingBottom: 40 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e5e5e5",
  },
  rowDark: { borderBottomColor: "#2a2a2a" },
  rowText: { flex: 1 },
  rowName: { fontSize: 15, fontWeight: "600", color: "#0a0a0a" },
  rowDesc: { fontSize: 12, color: "#999999", marginTop: 2 },
  badge: {
    backgroundColor: "#f3e8ff",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgeDark: { backgroundColor: "#2a1a3e" },
  badgeText: { fontSize: 10, color: "#8b5cf6", fontWeight: "600" },
})
