import { View, Text, TouchableOpacity, ScrollView, ActivityIndicator, StyleSheet } from "react-native"
import { Ionicons } from "@expo/vector-icons"
import { useTranslation } from "react-i18next"

// One /find/file result, re-anchored to an absolute server path.
export interface MentionItem {
  name: string
  relativePath: string
  absolutePath: string
}

interface Props {
  items: MentionItem[]
  searching: boolean
  noConnection: boolean
  isDark: boolean
  onSelect: (item: MentionItem) => void
}

export function MentionPopover({ items, searching, noConnection, isDark, onSelect }: Props) {
  const { t } = useTranslation()

  return (
    <View style={[s.popover, isDark && s.popoverDark]} testID="mention-popover">
      {noConnection ? (
        <View style={s.centerBox}>
          <Text style={[s.dim, isDark && s.metaDark]}>{t("chat.mentionPopover.noConnection")}</Text>
        </View>
      ) : searching ? (
        <View style={s.centerBox}>
          <ActivityIndicator size="small" color={isDark ? "#888888" : "#666666"} />
          <Text style={[s.dim, isDark && s.metaDark]}>{t("chat.mentionPopover.searching")}</Text>
        </View>
      ) : items.length === 0 ? (
        <View style={s.centerBox}>
          <Text style={[s.dim, isDark && s.metaDark]}>{t("chat.mentionPopover.empty")}</Text>
        </View>
      ) : (
        <ScrollView keyboardShouldPersistTaps="always" style={s.scroll}>
          {items.map((item) => (
            <TouchableOpacity
              key={item.absolutePath}
              style={s.item}
              onPress={() => onSelect(item)}
              testID={`mention-item-${item.name}`}
            >
              <Ionicons name="document-text-outline" size={16} color={isDark ? "#888888" : "#666666"} />
              <View style={s.textCol}>
                <Text style={[s.name, isDark && s.textWhite]} numberOfLines={1}>
                  {item.name}
                </Text>
                {item.relativePath !== item.name && (
                  <Text style={[s.path, isDark && s.metaDark]} numberOfLines={1}>
                    {item.relativePath}
                  </Text>
                )}
              </View>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  popover: {
    backgroundColor: "#ffffff",
    borderTopWidth: 1,
    borderTopColor: "#e5e5e5",
    maxHeight: 220,
  },
  popoverDark: { backgroundColor: "#1a1a1a", borderTopColor: "#2a2a2a" },
  scroll: { paddingVertical: 4 },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  textCol: { flex: 1 },
  name: { fontSize: 14, fontWeight: "500", color: "#0a0a0a" },
  textWhite: { color: "#ffffff" },
  path: { fontSize: 12, color: "#999999", marginTop: 1 },
  metaDark: { color: "#666666" },
  dim: { fontSize: 13, color: "#999999" },
  centerBox: { paddingVertical: 24, alignItems: "center", gap: 6 },
})
