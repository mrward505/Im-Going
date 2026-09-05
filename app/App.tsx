/**
 * I'm Going — iOS-first mobile app (Expo / React Native / TypeScript).
 * Slice 4a: app shell — navigation, typed API client, onboarding.
 */
import React from "react";
import { registerRootComponent } from "expo";
import RootNavigator from "./src/navigation/RootNavigator";

function App(): React.JSX.Element {
  return <RootNavigator />;
}

registerRootComponent(App);

export default App;