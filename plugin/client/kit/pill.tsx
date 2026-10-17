/**
 * The `Fleet surface`'s small UI kit: the status Pill, the button, and the
 * section Card — function components over raw react-native primitives, theme
 * colours only. No class syntax reaches the Hermes client bundle.
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { ViewStyle } from "react-native";
import { CONTROL_H, CONTROL_SM, PILL_H, RADIUS, SPACING, hoveredOf, text, tint } from "./theme.ts";
import type { Colour } from "./theme.ts";

/** One status Pill — online/offline, posture, run status, Reserve mode. */
export function Pill({
  theme,
  label,
  tone = "foregroundMuted",
  lit = false,
  icon,
  mono = false,
}: {
  theme: PluginTheme;
  label: string;
  tone?: Colour;
  lit?: boolean;
  icon?: string;
  mono?: boolean;
}) {
  const colour = theme.colors[tone];
  return (
    <View
      style={{
        minHeight: PILL_H,
        paddingHorizontal: SPACING[2],
        paddingVertical: 2,
        borderRadius: RADIUS.md,
        borderWidth: 1,
        borderColor: lit ? tint(colour, "66") : theme.colors.border,
        backgroundColor: lit ? tint(colour, "18") : theme.colors.surface2,
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        gap: SPACING[1],
      }}
    >
      {icon !== undefined ? <Icon name={icon} size={11} color={colour} /> : null}
      <Text style={{ ...text(theme, mono ? "code" : "badge"), fontSize: 11, lineHeight: 15, color: colour }} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** The surface's one button — self-sized, aligned height, bordered, hover + press feedback. */
export function Btn({
  theme,
  label,
  onPress,
  tone = "accent",
  disabled = false,
  small = false,
  icon,
  solid = false,
}: {
  theme: PluginTheme;
  label: string;
  onPress: () => void;
  tone?: Colour;
  disabled?: boolean;
  small?: boolean;
  icon?: string;
  solid?: boolean;
}) {
  const colour = theme.colors[tone];
  const isMuted = tone === "foregroundMuted";
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={(state) => {
        const isHovered = hoveredOf(state);
        const bg = disabled
          ? theme.colors.surface1
          : solid
            ? state.pressed
              ? tint(colour, "cc")
              : colour
            : state.pressed
              ? tint(colour, "2e")
              : isHovered
                ? isMuted
                  ? theme.colors.surface2
                  : tint(colour, "18")
                : isMuted
                  ? theme.colors.surface1
                  : tint(colour, "0d");
        const border = disabled
          ? theme.colors.border
          : isMuted
            ? isHovered
              ? theme.colors.foregroundMuted
              : theme.colors.border
            : tint(colour, state.pressed || isHovered ? "aa" : "66");
        return {
          minHeight: small ? CONTROL_SM : CONTROL_H,
          paddingHorizontal: small ? SPACING[2.5] : SPACING[3],
          paddingVertical: small ? 3 : 5,
          borderRadius: RADIUS.md,
          borderWidth: 1,
          borderColor: border,
          backgroundColor: bg,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          alignSelf: "flex-start",
          gap: SPACING[1.5],
          opacity: disabled ? 0.45 : 1,
        };
      }}
    >
      {icon !== undefined ? (
        <Icon
          name={icon}
          size={small ? 12 : 14}
          color={disabled ? theme.colors.foregroundMuted : solid ? theme.colors.surface0 : isMuted ? theme.colors.foreground : colour}
        />
      ) : null}
      <Text
        style={{
          ...text(theme, small ? "label" : "section"),
          fontSize: small ? 12 : 13,
          lineHeight: small ? 16 : 18,
          fontWeight: "600",
          color: disabled ? theme.colors.foregroundMuted : solid ? theme.colors.surface0 : isMuted ? theme.colors.foreground : colour,
        }}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** A section card — bordered surface with padding, the surface's one container. */
export function Card({
  theme,
  children,
  gap = SPACING[2.5],
  style,
}: {
  theme: PluginTheme;
  children: ReactNode;
  gap?: number;
  style?: ViewStyle;
}) {
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        borderRadius: RADIUS.lg,
        padding: SPACING[3],
        gap,
        ...style,
      }}
    >
      {children}
    </View>
  );
}
