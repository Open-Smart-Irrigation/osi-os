import {useEffect} from 'react';
import L from 'leaflet';
import {CircleMarker, MapContainer, Popup, Polyline, ZoomControl, useMap} from 'react-leaflet';
import offlineMapUrl from './offline-map.svg?url';

export {CircleMarker, MapContainer, Popup, Polyline, ZoomControl, useMap};

type OfflineLayerProps = {attribution?: string; url?: string; maxNativeZoom?: number};
export function TileLayer(_props: OfflineLayerProps) {
  const map = useMap();
  useEffect(() => {
    const layer = L.imageOverlay(offlineMapUrl, [[-80, -180], [80, 180]], {
      alt: 'Bundled illustrative world map', interactive: false, opacity: 1,
      className: 'osi-offline-map-image',
    }).addTo(map);
    return () => { layer.remove(); };
  }, [map]);
  return null;
}
