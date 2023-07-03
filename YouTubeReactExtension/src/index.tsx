import 'core-js/stable';
import 'regenerator-runtime/runtime';
import React from 'react';
import ReactDOM from 'react-dom/client';
// import { Provider } from 'react-redux';
// import { PersistGate } from 'redux-persist/integration/react';
// import { store, persistor } from './app/store';

import App from './app/SMPlayer';

ReactDOM.createRoot(document.getElementById('root')!).render(
    //  <Provider store={store}> 
        //  <PersistGate loading={null} persistor={persistor}>
            <App />
        //  </PersistGate>
    // </Provider>
);
