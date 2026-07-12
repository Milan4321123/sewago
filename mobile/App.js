import React, { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View
} from 'react-native';
import { WebView } from 'react-native-webview';

const APPS = [
  { label: 'Customer', path: '/' },
  { label: 'Driver', path: '/driver' },
  { label: 'Partner', path: '/partner' },
  { label: 'Admin', path: '/admin' }
];

// Fallback only. Real builds should set EXPO_PUBLIC_SEWAGO_URL to the deployed https URL.
const DEFAULT_URL = 'https://sewago.onrender.com';

function appBaseUrl() {
  return (process.env.EXPO_PUBLIC_SEWAGO_URL || DEFAULT_URL).replace(/\/$/, '');
}

function appUrl(path) {
  return `${appBaseUrl()}${path}`;
}

export default function App() {
  const webRef = useRef(null);
  const [active, setActive] = useState(APPS[0]);
  const [loading, setLoading] = useState(true);
  const source = useMemo(() => ({ uri: appUrl(active.path) }), [active]);

  return (
    <SafeAreaView style={styles.shell}>
      <StatusBar barStyle="light-content" />
      <View style={styles.header}>
        <View>
          <Text style={styles.brand}>SewaGo</Text>
          <Text style={styles.url}>{appBaseUrl()}</Text>
        </View>
        <Pressable style={styles.reload} onPress={() => webRef.current?.reload()}>
          <Text style={styles.reloadText}>Reload</Text>
        </Pressable>
      </View>

      <View style={styles.tabs}>
        {APPS.map((item) => (
          <Pressable
            key={item.path}
            style={[styles.tab, active.path === item.path && styles.activeTab]}
            onPress={() => {
              setLoading(true);
              setActive(item);
            }}
          >
            <Text style={[styles.tabText, active.path === item.path && styles.activeTabText]}>
              {item.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.webWrap}>
        <WebView
          ref={webRef}
          source={source}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          geolocationEnabled
          allowsInlineMediaPlayback
          onLoadStart={() => setLoading(true)}
          onLoadEnd={() => setLoading(false)}
          style={styles.web}
        />
        {loading ? (
          <View style={styles.loading}>
            <ActivityIndicator color="#22c55e" />
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    backgroundColor: '#0b0d12'
  },
  header: {
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#262e40'
  },
  brand: {
    color: '#e8ecf4',
    fontSize: 20,
    fontWeight: '900'
  },
  url: {
    color: '#8b93a7',
    fontSize: 11,
    marginTop: 2
  },
  reload: {
    borderWidth: 1,
    borderColor: '#262e40',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  reloadText: {
    color: '#22c55e',
    fontWeight: '800'
  },
  tabs: {
    flexDirection: 'row',
    gap: 6,
    padding: 8,
    backgroundColor: '#11141c'
  },
  tab: {
    flex: 1,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: '#1c2230'
  },
  activeTab: {
    backgroundColor: '#22c55e'
  },
  tabText: {
    color: '#8b93a7',
    fontSize: 12,
    fontWeight: '800'
  },
  activeTabText: {
    color: '#04130a'
  },
  webWrap: {
    flex: 1,
    position: 'relative'
  },
  web: {
    flex: 1,
    backgroundColor: '#0b0d12'
  },
  loading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(11, 13, 18, 0.35)'
  }
});
