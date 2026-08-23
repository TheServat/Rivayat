import { createPinia } from 'pinia';
import { createApp } from 'vue';

import App from './App.vue';
import './design/index';
import { createStudioI18n } from './i18n/index';
import { createStudioRouter } from './router/index';
import { useLocaleStore } from './stores/locale.store';

/**
 * Boot order matters exactly once, here.
 *
 * Pinia has to be installed before the locale store is read, and the locale store has
 * to be read before `createStudioI18n`, so that the first render is already in the
 * stored language. Creating i18n at `fa` and correcting it afterwards would repaint the
 * whole interface on every reload for an English-speaking user, and would flash `rtl`
 * before settling on `ltr`.
 */
const app = createApp(App);
const pinia = createPinia();
app.use(pinia);

const localeStore = useLocaleStore(pinia);
app.use(createStudioI18n(localeStore.locale));
app.use(createStudioRouter());

app.mount('#app');
