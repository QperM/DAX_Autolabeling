import React from 'react';
import { Provider } from 'react-redux';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { store } from './store';
import LandingPage from './components/LandingPage';
import AnnotationPage from './components/AnnotationPage';
import ManualAnnotation from './components/ManualAnnotation';
import './App.css';

const AppContent: React.FC = () => {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/annotate" element={<AnnotationPage />} />
        <Route path="/annotate/manual-annotation" element={<ManualAnnotation />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
};

function App() {
  return (
    <Provider store={store}>
      <AppContent />
    </Provider>
  );
}

export default App;