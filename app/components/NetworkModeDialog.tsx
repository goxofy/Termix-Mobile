import { View, Modal, Pressable, ActivityIndicator } from "react-native";
import { Network, RefreshCw, Server, Wifi, X } from "lucide-react-native";
import { Text, Button } from "@/app/components/ui";
import { useThemeColor } from "@/app/contexts/ThemeContext";

export type NetworkModeChoice = "direct" | "tailscale";

type Props = {
  visible: boolean;
  busy?: boolean;
  canUseTailscale?: boolean;
  retryMode?: NetworkModeChoice | null;
  serverLabel?: string;
  errorMessage?: string | null;
  onChoose: (mode: NetworkModeChoice) => void;
  onRetry?: () => void;
  onCancel: () => void;
  onChangeServer: () => void;
};

/** Choose a transport after a material network change or recover from failure. */
export function NetworkModeDialog({
  visible,
  busy,
  canUseTailscale = true,
  retryMode,
  serverLabel,
  errorMessage,
  onChoose,
  onRetry,
  onCancel,
  onChangeServer,
}: Props) {
  const color = useThemeColor();
  const muted = color("muted-foreground") ?? "#888";
  const accent = color("accent-brand") ?? "#f59145";
  const foreground = color("foreground") ?? "#fff";

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <View className="flex-1 items-center justify-center bg-black/70 px-6">
        <View className="w-full max-w-md border border-border bg-card p-5">
          <View className="mb-3 flex-row items-start justify-between gap-3">
            <View className="min-w-0 flex-1">
              <Text weight="bold" className="text-base text-foreground">
                {busy ? "Connecting…" : "How do you want to connect?"}
              </Text>
              {serverLabel ? (
                <Text
                  className="mt-1 text-[11px] text-muted-foreground"
                  numberOfLines={2}
                >
                  {serverLabel.replace(/^https?:\/\//, "")}
                </Text>
              ) : null}
            </View>
            <Pressable onPress={onCancel} hitSlop={10}>
              <X size={18} color={muted} />
            </Pressable>
          </View>

          <Text className="mb-4 text-[11px] leading-4 text-muted-foreground">
            {canUseTailscale
              ? "The network topology changed. Use Direct on a reachable LAN, or Tailscale when the server is available through your tailnet."
              : "Validate the configured server directly on the current network."}
          </Text>

          {errorMessage ? (
            <View className="mb-4 border border-red-500/50 bg-red-500/10 px-3 py-2.5">
              <Text className="text-[11px] leading-4 text-red-400">
                {errorMessage}
              </Text>
            </View>
          ) : null}

          {busy ? (
            <View className="gap-2.5">
              <View className="items-center py-4">
                <ActivityIndicator color={accent} />
                <Text className="mt-3 text-sm text-muted-foreground">
                  Validating the Termix server…
                </Text>
              </View>
              <Button variant="outline" onPress={onCancel}>
                Cancel attempt
              </Button>
              <Button
                variant="ghost"
                onPress={onChangeServer}
                icon={<Server size={15} color={foreground} />}
              >
                Change server
              </Button>
            </View>
          ) : (
            <View className="gap-2.5">
              {errorMessage && retryMode && onRetry ? (
                <Button
                  variant="accent"
                  size="lg"
                  onPress={onRetry}
                  icon={<RefreshCw size={16} color={accent} />}
                >
                  Retry {retryMode === "tailscale" ? "Via Tailscale" : "Direct"}
                </Button>
              ) : null}
              <Button
                variant={
                  errorMessage && retryMode === "direct" ? "outline" : "accent"
                }
                size="lg"
                onPress={() => onChoose("direct")}
                icon={<Wifi size={16} color={accent} />}
              >
                Direct / LAN
              </Button>
              {canUseTailscale ? (
                <Button
                  variant="outline"
                  size="lg"
                  onPress={() => onChoose("tailscale")}
                  icon={<Network size={16} color={foreground} />}
                >
                  Via Tailscale
                </Button>
              ) : null}
              <Button
                variant="ghost"
                onPress={onChangeServer}
                icon={<Server size={15} color={foreground} />}
              >
                Change server
              </Button>
              <Button variant="ghost" onPress={onCancel}>
                Cancel
              </Button>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}
