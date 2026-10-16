import { FolderTree, Inbox, Settings } from "lucide-react-native";
import { Tabs } from "expo-router/js-tabs";
import { useCSSVariable } from "uniwind";
import { useInboxCount } from "@ret/state/inbox";
import { NewThreadButton } from "../../ui/NewThread";

export default function TabsLayout() {
  const count = useInboxCount();
  const [bg1, line, text, text3, accent, amber] = useCSSVariable(["--color-bg-1", "--color-line", "--color-text", "--color-text-3", "--color-accent", "--color-amber"]) as string[];
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: bg1 },
        headerShadowVisible: false,
        headerTintColor: text,
        headerTitleStyle: { fontSize: 17, fontWeight: "600" },
        tabBarStyle: { backgroundColor: bg1, borderTopColor: line },
        tabBarActiveTintColor: accent,
        tabBarInactiveTintColor: text3,
        headerRightContainerStyle: { paddingRight: 14 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Inbox",
          headerRight: () => <NewThreadButton />,
          tabBarIcon: ({ color, size }) => <Inbox color={color} size={size - 2} />,
          tabBarBadge: count || undefined,
          tabBarBadgeStyle: { backgroundColor: amber, color: "#0b0b18", fontSize: 11 },
        }}
      />
      <Tabs.Screen name="projects" options={{ title: "Projects", headerRight: () => <NewThreadButton />, tabBarIcon: ({ color, size }) => <FolderTree color={color} size={size - 2} /> }} />
      <Tabs.Screen name="settings" options={{ title: "Settings", tabBarIcon: ({ color, size }) => <Settings color={color} size={size - 2} /> }} />
    </Tabs>
  );
}
