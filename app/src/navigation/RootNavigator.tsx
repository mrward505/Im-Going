/**
 * App navigation — root stack (Onboarding → Main tabs) + bottom tabs
 * (Trending | My Plans | Profile) per spec §3.
 *
 * Slice 4b: Trending + My Plans are real; Announce is a modal sheet launched
 * from the FAB; spot rows open the 4b stub (full detail lands in 4c).
 */
import React, { useState } from "react";
import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { NavigationContainer, DefaultTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import { getToken, setCachedUser } from "../api/tokenStorage";
import { colors } from "../theme";
import { OnboardingFlow } from "../screens/onboarding/OnboardingFlow";
import { ProfileScreen } from "../screens/ProfileScreen";
import { TrendingScreen } from "../screens/TrendingScreen";
import { MyPlansScreen } from "../screens/MyPlansScreen";
import { AnnounceSheet } from "../screens/AnnounceSheet";
import { SpotDetailStub } from "../screens/SpotDetailStub";

export type RootStackParamList = {
  Onboarding: undefined;
  Main: undefined;
};

export type MainTabParamList = {
  Trending: undefined;
  MyPlans: undefined;
  Profile: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();

const navTheme = {
  ...DefaultTheme,
  dark: true,
  colors: {
    ...DefaultTheme.colors,
    background: colors.background,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
    primary: colors.primary,
  },
};

function MainTabs({ onLogout }: { onLogout: () => void }): React.JSX.Element {
  const [announceOpen, setAnnounceOpen] = useState(false);
  const [openSpotId, setOpenSpotId] = useState<string | null>(null);
  const [plansTick, setPlansTick] = useState(0);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {openSpotId ? (
        <SpotDetailStub spotId={openSpotId} onBack={() => setOpenSpotId(null)} />
      ) : (
        <Tab.Navigator
          screenOptions={{
            headerShown: false,
            tabBarActiveTintColor: colors.primary,
            tabBarInactiveTintColor: colors.textDim,
            tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
          }}
        >
          <Tab.Screen
            name="Trending"
            options={{ tabBarIcon: ({ color, size }) => <Ionicons name="flame" size={size} color={color} /> }}
          >
            {() => (
              <TrendingScreen
                onAnnounce={() => setAnnounceOpen(true)}
                onOpenSpot={(id) => setOpenSpotId(id)}
              />
            )}
          </Tab.Screen>
          <Tab.Screen
            name="MyPlans"
            options={{ tabBarIcon: ({ color, size }) => <Ionicons name="calendar" size={size} color={color} /> }}
          >
            {() => <MyPlansScreen key={plansTick} />}
          </Tab.Screen>
          <Tab.Screen
            name="Profile"
            options={{ tabBarIcon: ({ color, size }) => <Ionicons name="person" size={size} color={color} /> }}
          >
            {() => <ProfileScreen onLogout={onLogout} />}
          </Tab.Screen>
        </Tab.Navigator>
      )}
      <AnnounceSheet
        visible={announceOpen}
        onClose={() => setAnnounceOpen(false)}
        onPublished={() => {
          setAnnounceOpen(false);
          setPlansTick((t) => t + 1);
        }}
      />
    </View>
  );
}

function Root(): React.JSX.Element {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    void (async () => {
      const token = await getToken();
      if (token) await setCachedUser(null); // cached user refetched on Profile
      setAuthed(token !== null);
      setReady(true);
    })();
  }, []);

  if (!ready) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <NavigationContainer theme={navTheme}>
      <StatusBar style="light" />
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {authed ? (
          <Stack.Screen name="Main" component={() => <MainTabs onLogout={() => setAuthed(false)} />} />
        ) : (
          <Stack.Screen name="Onboarding">
            {() => (
              <OnboardingFlow
                onDone={(user) => {
                  void user;
                  setAuthed(true);
                }}
              />
            )}
          </Stack.Screen>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default Root;

const styles = StyleSheet.create({
  boot: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
});
