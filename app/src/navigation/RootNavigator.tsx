/**
 * App navigation — root stack (Onboarding → Main tabs) + bottom tabs
 * (Trending | My Plans | Profile) per spec §3.
 */
import React, { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { NavigationContainer, DefaultTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import { getToken, setCachedUser } from "../api/tokenStorage";
import { colors } from "../theme";
import { OnboardingFlow } from "../screens/onboarding/OnboardingFlow";
import { PlaceholderScreen } from "../screens/Placeholder";
import { ProfileScreen } from "../screens/ProfileScreen";

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
  return (
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
        component={() => (
          <PlaceholderScreen
            title="Trending"
            subtitle="Top Tempe spots — who's going where tonight."
          />
        )}
        options={{ tabBarIcon: ({ color, size }) => <Ionicons name="flame" size={size} color={color} /> }}
      />
      <Tab.Screen
        name="MyPlans"
        component={() => (
          <PlaceholderScreen
            title="My Plans"
            subtitle="Your going announcements and their outcome."
          />
        )}
        options={{ tabBarIcon: ({ color, size }) => <Ionicons name="calendar" size={size} color={color} /> }}
      />
      <Tab.Screen
        name="Profile"
        component={() => <ProfileScreen onLogout={onLogout} />}
        options={{ tabBarIcon: ({ color, size }) => <Ionicons name="person" size={size} color={color} /> }}
      />
    </Tab.Navigator>
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