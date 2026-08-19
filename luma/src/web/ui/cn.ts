import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Joins class names and lets a caller's utility win over a component's default,
 * which is what makes `<Button className="w-full">` work without every variant
 * growing a prop.
 */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
