declare module 'thai-address-database' {
  /** Note: the library labels sub-district as `district` and district as `amphoe`. */
  export interface ThaiAddressRow {
    district: string   // sub-district (ตำบล/แขวง)
    amphoe: string     // district (อำเภอ/เขต)
    province: string   // จังหวัด
    zipcode: string
  }
  export function searchAddressByDistrict(query: string): ThaiAddressRow[]
  export function searchAddressByAmphoe(query: string): ThaiAddressRow[]
  export function searchAddressByProvince(query: string): ThaiAddressRow[]
  export function searchAddressByZipcode(query: string | number): ThaiAddressRow[]
  export function splitAddress(address: string): unknown
}
