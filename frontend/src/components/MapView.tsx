import dynamic from 'next/dynamic';

const MapViewInner = dynamic(() => import('./MapViewInner'), {
  ssr: false,
  loading: () => <div className="w-full h-full bg-polar-900 rounded-xl flex items-center justify-center text-polar-400">Loading Map...</div>
});

export const MapView = (props: any) => {
  return <MapViewInner {...props} />;
};
