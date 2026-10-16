import "../global.css";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useRef } from "react";
import { LogBox, View } from "react-native";
import { Uniwind, useCSSVariable, useUniwind } from "uniwind";
import { bootstrap } from "@ret/state/actions";
import { startExternalWatcher } from "@ret/state/external";
import { useUI } from "@ret/state/ui";
import { startNotifications } from "../platform/notifications";
import { Toasts } from "../ui/Toasts";

// The desktop's stores, wired to the phone's bridge, as its renderer starts them (main.tsx).
bootstrap();
startExternalWatcher();
// The saved theme before anything draws. (Set before any view exists, Uniwind's dev build warns
// that it had nothing to update: nothing had drawn yet, which is the point.)
Uniwind.setTheme(useUI.getState().theme);
LogBox.ignoreLogs(["Uniwind - Theme transition was cancelled because no shadow nodes were registered"]);

export default function RootLayout() {
  // The theme is the desktop's setting (Settings → Appearance), Ret's own palette either way.
  const theme = useUI((s) => s.theme);
  const applied = useRef(theme);
  useEffect(() => {
    if (applied.current === theme) return;
    applied.current = theme;
    Uniwind.setTheme(theme);
  }, [theme]);
  // Notices while away, and opening the thread a tapped one is about (once the navigator exists).
  useEffect(() => startNotifications(), []);
  const { theme: active } = useUniwind();
  const [bg, bg1, text, line, accent] = useCSSVariable(["--color-bg", "--color-bg-1", "--color-text", "--color-line", "--color-accent"]) as string[];
  const navTheme = useMemo(() => {
    const base = active === "light" ? DefaultTheme : DarkTheme;
    return { ...base, colors: { ...base.colors, primary: accent, background: bg, card: bg1, text, border: line, notification: accent } };
  }, [active, bg, bg1, text, line, accent]);

  return (
    <ThemeProvider value={navTheme}>
      <StatusBar style={active === "light" ? "dark" : "light"} />
      <View className="flex-1 bg-bg">
        <Stack screenOptions={{ headerShadowVisible: false, headerStyle: { backgroundColor: bg1 }, headerTintColor: text, contentStyle: { backgroundColor: bg } }}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="thread/[id]" options={{ title: "", headerBackTitle: "Back" }} />
          <Stack.Screen name="pair" options={{ presentation: "modal", title: "Pair with a computer" }} />
          <Stack.Screen name="file" options={{ title: "", headerBackTitle: "Back" }} />
          <Stack.Screen name="files" options={{ title: "", headerBackTitle: "Back" }} />
        </Stack>
        <Toasts />
      </View>
    </ThemeProvider>
  );
}
