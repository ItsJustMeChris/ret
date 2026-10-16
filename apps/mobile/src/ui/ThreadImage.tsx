import { ImageOff, X } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Image, Modal, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { resolvePath } from "@ret/lib/files";
import { loadImage } from "../platform/images";
import { Icon, Spinner } from "./primitives";

/**
 * An image in a thread, as the desktop's ThreadImage: a file on the computer the thread runs on
 * (`path`, relative to `cwd`), or one carried in the message (`src`, a data URI). Tap to see it whole.
 */
export function ThreadImage({ path, cwd, host, src, size = "md" }: { path?: string; cwd?: string | null; host?: string | null; src?: string; size?: "sm" | "md" }) {
  const [uri, setUri] = useState<string | null | undefined>(src);
  const [ratio, setRatio] = useState(4 / 3);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (src || !path) return;
    let live = true;
    loadImage(resolvePath(path, cwd), host ?? null).then(
      (u) => live && setUri(u),
      () => live && setUri(null),
    );
    return () => {
      live = false;
    };
  }, [path, cwd, host, src]);
  useEffect(() => {
    if (uri) Image.getSize(uri, (w, h) => h && setRatio(w / h), () => {});
  }, [uri]);

  const box = size === "sm" ? "h-16 w-16" : "w-full max-w-[280px]";
  if (uri === null) {
    return (
      <View className={`${size === "sm" ? box : "h-24 w-40"} items-center justify-center rounded-lg border border-line bg-bg-2`}>
        <Icon icon={ImageOff} size={18} colorClassName="accent-text-3" />
      </View>
    );
  }
  if (uri === undefined) {
    return (
      <View className={`${size === "sm" ? box : "h-40 w-56"} items-center justify-center rounded-lg border border-line bg-bg-2`}>
        <Spinner size="small" colorClassName="accent-text-3" />
      </View>
    );
  }
  return (
    <>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="imagebutton" accessibilityLabel="Image">
        <Image source={{ uri }} className={`${box} rounded-lg border border-line-2`} style={size === "sm" ? undefined : { aspectRatio: ratio, maxHeight: 360 }} resizeMode="cover" />
      </Pressable>
      <ImageViewer uri={open ? uri : null} onClose={() => setOpen(false)} />
    </>
  );
}

/** The image on its own, full screen, pinch to zoom. */
export function ImageViewer({ uri, onClose }: { uri: string | null; onClose: () => void }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={!!uri} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View className="flex-1 bg-black">
        {uri ? (
          <ScrollView maximumZoomScale={5} minimumZoomScale={1} centerContent contentContainerStyle={{ width, height }} showsHorizontalScrollIndicator={false} showsVerticalScrollIndicator={false}>
            <Pressable onPress={onClose} style={{ width, height }}>
              <Image source={{ uri }} style={{ width, height }} resizeMode="contain" />
            </Pressable>
          </ScrollView>
        ) : null}
        <Pressable onPress={onClose} accessibilityLabel="Close" className="absolute right-4 h-10 w-10 items-center justify-center rounded-full bg-white/15" style={{ top: insets.top + 8 }}>
          <Icon icon={X} size={20} colorClassName="accent-white" />
        </Pressable>
      </View>
    </Modal>
  );
}
