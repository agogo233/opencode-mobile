import { View, Text, TouchableOpacity, StyleSheet } from "react-native"
import { Ionicons } from "@expo/vector-icons"

// Compact chip for non-image attachments (server-side file:// references
// from @-mentions). Images keep their thumbnail rendering in
// ImageAttachments; this chip is the only place a file part shows up as a
// removable pill, so its `onRemove` is optional (sent-message bubbles
// render it without the remove button).
interface Props {
  filename: string
  isDark: boolean
  onRemove?: () => void
}

export function FileAttachmentChip({ filename, isDark, onRemove }: Props) {
  return (
    <View style={[s.chip, isDark && s.chipDark]} testID="file-attachment-chip">
      <Ionicons name="document-text-outline" size={14} color={isDark ? "#a78bfa" : "#6d28d9"} />
      <Text style={[s.label, isDark && s.labelDark]} numberOfLines={1}>
        {filename}
      </Text>
      {onRemove && (
        <TouchableOpacity style={[s.remove, isDark && s.removeDark]} onPress={onRemove} hitSlop={8} testID="file-attachment-remove">
          <Ionicons name="close" size={12} color={isDark ? "#111111" : "#ffffff"} />
        </TouchableOpacity>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "#f3e8ff",
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
    maxWidth: 200,
  },
  chipDark: { backgroundColor: "#2a1a3e" },
  label: {
    fontSize: 12,
    fontWeight: "500",
    color: "#6d28d9",
  },
  labelDark: { color: "#c4b5fd" },
  remove: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "#6d28d9",
    justifyContent: "center",
    alignItems: "center",
  },
  removeDark: { backgroundColor: "#111111" },
})
