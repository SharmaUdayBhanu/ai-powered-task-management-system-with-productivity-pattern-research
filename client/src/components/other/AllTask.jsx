import React, { useContext } from 'react'
import {AuthContext} from '../../context/AuthProvider'; 
const AllTask = () => {
  const authData = useContext(AuthContext);
  console.log(authData)
  return (<>
    <div className="bg-[#1c1c1c] p-2 mt-10 h-55 rounded-xl overflow-x-auto">
    <div className="bg-red-400 mb-2 py-2 px-4 flex flex-row justify-between rounded-sm min-w-[600px]">
        <h2 className='w-1/5 text-sm sm:text-base'>Employee Name</h2>
        <h3 className='w-1/5 text-sm sm:text-base'>New Task</h3>
        <h5 className='w-1/5 text-sm sm:text-base'>Active Task</h5>
        <h5 className='w-1/5 text-sm sm:text-base'>completed Task</h5>
        <h5 className='w-1/5 text-sm sm:text-base'>Failed Task</h5>
      </div>
      <div className="h-[80%] overflow-y-auto scroll-smooth snap-y snap-mandatory min-w-[600px]">
      {authData.employees.map(function(elem , idx){
        return <div className="border-2 border-amber-100 mb-2 py-2 px-4 flex flex-row justify-between rounded-sm snap-start min-w-[600px]" key={idx}>
        <h2 className='w-1/4 text-sm sm:text-lg'>{elem.firstName}</h2>
        <h3 className='w-1/4 text-sm sm:text-lg text-blue-600'>{elem.taskCounts.newTask}</h3>
        <h3 className='w-1/5 text-sm sm:text-lg text-yellow-400'>{elem.taskCounts.active}</h3>
        <h3 className='w-1/5 text-sm sm:text-lg'>{elem.taskCounts.completed}</h3>
        <h5 className='w-1/5 text-sm sm:text-lg text-red-500'>{elem.taskCounts.failed}</h5>
      </div>
      })}
    </div>
    </div>
    
    </>
  )
}

export default AllTask