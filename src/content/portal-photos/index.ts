import type { StaticImageData } from "next/image";
import barbaPerfilado from "./barba-perfilado.jpg";
import corteTijeras from "./corte-tijeras.jpg";
import heroNavaja from "./hero-navaja.jpg";
import localClasico from "./local-clasico.jpg";
import localHerramientas from "./local-herramientas.jpg";
import localSalon from "./local-salon.jpg";
import localSilla from "./local-silla.jpg";

// Fotos de la portada (docs/sprint-6-portal-abrebocas.md).
//
// HOY SON FOTOS DE REFERENCIA: de Unsplash (licencia libre, unsplash.com/license), NO son de
// Barbería Villa. Sirven para la demo al dueño y para ver el diseño con imágenes. Por eso solo se
// muestran con showsReferencePhotos() (desarrollo, o PORTAL_REFERENCE_PHOTOS=1 en un staging).
// Cuando lleguen las del local: se reemplazan los archivos, `reference` pasa a false y se muestran
// siempre. Fotos con personas reconocibles: solo con su autorización escrita (Ley 1581).

export interface PortalPhoto {
  src: StaticImageData;
  alt: string;
  /** Autor y fuente, para el registro (la licencia de Unsplash no exige mostrarlo). */
  credit: string;
  /** true: foto de muestra, no del local. */
  reference: boolean;
}

export const HERO_PHOTO: PortalPhoto = {
  src: heroNavaja,
  alt: "Barbero perfilando con navaja el corte de un cliente",
  credit: "Agustin Fernandez · Unsplash 1Pmp9uxK8X8",
  reference: true,
};

/** Galería "El local", en el orden del mosaico (ver GALLERY_LAYOUT en la portada). */
export const GALLERY_PHOTOS: readonly PortalPhoto[] = [
  { src: localSalon, alt: "La barbería por dentro: sillas en fila frente a los espejos", credit: "Barney Goodman · Unsplash AXurvQTtO3Y", reference: true },
  { src: corteTijeras, alt: "Corte con tijera de entresacar y peine", credit: "Gulom Nazarov · Unsplash DrG4V5skbMY", reference: true },
  { src: barbaPerfilado, alt: "Perfilado de barba con tijera, en blanco y negro", credit: "Nathon Oski · Unsplash fE42nRlBcG8", reference: true },
  { src: localSilla, alt: "Silla de barbero de cuero negro junto a una pared de ladrillo", credit: "Nathon Oski · Unsplash EW_rqoSdDes", reference: true },
  { src: localHerramientas, alt: "Tijeras, peine y productos sobre una tabla", credit: "Andrea Donato · Unsplash MNu0n-3BIKs", reference: true },
  { src: localClasico, alt: "Un día normal en la barbería, con clientes en las sillas", credit: "Barney Goodman · Unsplash aM2VSVn8ktg", reference: true },
];
